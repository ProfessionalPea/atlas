const { chromium } = require('playwright');
const { Pool } = require('pg');
const {
  initializeIntelligenceFeatures,
  persistVideoAssets
} = require('./IntelligenceFeatures');
const { extractVideoAssets } = require('./GoogleAdsScannerV2');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const videoPool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});
let videoDbReady = false;

async function ensureVideoDb() {
  if (videoDbReady) return;
  await initializeIntelligenceFeatures(videoPool);
  videoDbReady = true;
}

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const value = pkg.trim();
  const lower = value.toLowerCase();
  const validPrefixes = ['com.', 'io.', 'net.', 'org.', 'games.'];
  if (!validPrefixes.some(prefix => lower.startsWith(prefix))) return false;
  const blacklist = [
    'goog.', 'com.google.', 'com.android.', 'com.apple.',
    'org.w3c.', 'org.apache.', 'io.github.'
  ];
  if (blacklist.some(prefix => lower.startsWith(prefix))) return false;
  if (value.includes('_KNOWN_') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.png')) return false;
  return value.split('.').length >= 2;
}

function decodeForInspection(value) {
  let decoded = String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/');

  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function addPackage(set, value) {
  if (!isValidPackage(value)) return;
  set.add(String(value).trim().toLowerCase());
}

// This intentionally restores the September scanner's broad discovery model.
// An ad limit limits creatives inspected, not games discovered. One creative can
// contribute several valid package candidates.
function extractBroadPackages(value) {
  const decoded = decodeForInspection(value);
  const found = new Set();

  const destinationRegex = /(?:id=|id%3D|details\?id=|details%3Fid%3D|market:\/\/details\?id=)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi;
  for (const match of decoded.matchAll(destinationRegex)) addPackage(found, match[1]);

  const keyedRegex = /(?:packageName|package_name|appId|app_id|bundleId|androidPackageName|android_package_name|applicationId|application_id)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;
  for (const match of decoded.matchAll(keyedRegex)) addPackage(found, match[1]);

  // This broad quoted dotted-string pass is the behavior that allowed a
  // 10-creative scan to legitimately discover >10 games. Validation and the DB
  // package_name uniqueness constraint still prevent duplicate game rows.
  const delimitedRegex = /["'`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})["'`]/g;
  for (const match of decoded.matchAll(delimitedRegex)) addPackage(found, match[1]);

  return [...found];
}

function extractExplicitStorePackages(value) {
  const decoded = decodeForInspection(value);
  const found = new Set();
  const patterns = [
    /play\.google\.com\/store\/apps\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi,
    /market:\/\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) addPackage(found, match[1]);
  }
  return [...found];
}

function normalizeUrl(value) {
  const decoded = decodeForInspection(value).trim();
  if (!decoded) return null;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return null;
}

function parseMediaRequest(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  if (!/googlevideo\.com\/videoplayback|\.(?:mp4|webm)(?:\?|$)/i.test(normalized)) return null;
  try {
    const parsed = new URL(normalized);
    const duration = Number(parsed.searchParams.get('dur'));
    const expire = Number(parsed.searchParams.get('expire'));
    return {
      source: parsed.hostname.includes('googlevideo.com') ? 'youtube' : 'direct',
      mediaUrl: normalized,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      mediaUrlExpiresAt: Number.isFinite(expire) && expire > 0 ? new Date(expire * 1000).toISOString() : null,
      mimeType: parsed.searchParams.get('mime') || null
    };
  } catch {
    return { source: 'direct', mediaUrl: normalized };
  }
}

function stableAssetKey(asset) {
  if (asset?.youtubeId) return `youtube:${asset.youtubeId}`;
  if (asset?.mediaUrl) {
    try {
      const parsed = new URL(asset.mediaUrl);
      return `media:${parsed.origin}${parsed.pathname}`;
    } catch {
      return `media:${String(asset.mediaUrl).split('?')[0]}`;
    }
  }
  if (asset?.thumbnailUrl) return `thumb:${asset.thumbnailUrl}`;
  return null;
}

function mergeVideoAsset(map, asset) {
  if (!asset) return;
  const key = stableAssetKey(asset);
  if (!key) return;
  const existing = map.get(key) || {};
  map.set(key, {
    ...existing,
    ...Object.fromEntries(Object.entries(asset).filter(([, value]) => value !== null && value !== undefined && value !== '')),
    metadata: { ...(existing.metadata || {}), ...(asset.metadata || {}) }
  });
}

function getFrameEvidence(map, frame) {
  if (!frame) return null;
  let evidence = map.get(frame);
  if (!evidence) {
    evidence = { packages: new Set(), videos: new Map() };
    map.set(frame, evidence);
  }
  return evidence;
}

function buildSafeVideoAttribution(frameEvidence, videoMap) {
  const claims = new Map();

  for (const evidence of frameEvidence.values()) {
    // Discovery is broad, but video ownership remains strict. Only one explicit
    // Play destination in the exact same frame can claim a video.
    if (evidence.packages.size !== 1 || evidence.videos.size === 0) continue;
    const [packageName] = [...evidence.packages];
    for (const [key, asset] of evidence.videos.entries()) {
      if (!claims.has(key)) claims.set(key, { asset, packages: new Set() });
      const claim = claims.get(key);
      claim.asset = { ...claim.asset, ...asset };
      claim.packages.add(packageName);
    }
  }

  const packageAssets = new Map();
  const assigned = new Set();
  for (const [key, claim] of claims.entries()) {
    if (claim.packages.size !== 1) continue;
    const [packageName] = [...claim.packages];
    if (!packageAssets.has(packageName)) packageAssets.set(packageName, new Map());
    mergeVideoAsset(packageAssets.get(packageName), claim.asset);
    assigned.add(key);
  }

  const unassigned = [];
  for (const [key, asset] of videoMap.entries()) {
    if (!assigned.has(key)) unassigned.push(asset);
  }

  return {
    packageAssets: new Map([...packageAssets.entries()].map(([pkg, assets]) => [pkg, [...assets.values()]])),
    unassigned,
    assignedCount: assigned.size
  };
}

async function persistCreativeVideos(creativeId, advertiserId, attribution, allAssets) {
  if (!Array.isArray(allAssets) || allAssets.length === 0) return;
  try {
    await ensureVideoDb();
    for (const [packageName, assets] of attribution.packageAssets.entries()) {
      if (!assets.length) continue;
      await persistVideoAssets(videoPool, {
        creativeId,
        packageName,
        gameId: null,
        competitorId: null,
        advertiserId,
        assets
      });
    }

    if (attribution.unassigned.length) {
      await persistVideoAssets(videoPool, {
        creativeId,
        packageName: '',
        gameId: null,
        competitorId: null,
        advertiserId,
        assets: attribution.unassigned
      });
    }
  } catch (error) {
    console.warn(`🎬 [Broad Scanner] Video persistence skipped for ${creativeId}:`, error.message);
  }
}

async function scanCompetitor(
  searchQuery,
  targetCountry,
  maxAdsToTest = 500,
  onProgress = () => {},
  onPackageFound = async () => {},
  isCancelled = () => false
) {
  const query = String(searchQuery || '').trim();
  const startTime = Date.now();

  const emitProgress = (current, total, log) => {
    let timeRemaining = 'Calculating...';
    if (current > 0 && total > 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const remainingSeconds = Math.max(0, Math.round((total - current) * (elapsedSeconds / current)));
      const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
      const secs = (remainingSeconds % 60).toString().padStart(2, '0');
      timeRemaining = `${mins}:${secs}`;
    }
    onProgress({ currentAd: current, totalAds: total, timeRemaining, log });
  };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--no-zygote',
      '--disable-site-isolation-trials'
    ]
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  const searchPage = await context.newPage();
  await searchPage.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) route.abort();
    else route.continue();
  });

  try {
    searchPage.setDefaultTimeout(120000);
    searchPage.setDefaultNavigationTimeout(120000);

    let arId = null;
    const adIds = new Set();
    let hasClicked = false;

    emitProgress(0, maxAdsToTest, `> 🚀 Booting broad discovery scanner for "${query}"`);
    searchPage.on('response', async res => {
      try {
        const url = res.url();
        if (url.includes('SearchAdvertisers')) return;
        if (!hasClicked || !['xhr', 'fetch'].includes(res.request().resourceType())) return;

        if (!arId) {
          const postData = res.request().postData() || '';
          const match = url.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
          if (match) arId = match[1];
        }
        const text = await res.text();
        if (!arId) arId = text.match(/(AR[0-9]{15,})/)?.[1] || null;
        for (const match of text.matchAll(/"(CR[0-9]+)"/g)) adIds.add(match[1]);
      } catch {}
    });

    if (/^AR[0-9]{15,}$/i.test(query)) {
      arId = query.toUpperCase();
      hasClicked = true;
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, {
        waitUntil: 'domcontentloaded', timeout: 60000
      });
      await searchPage.waitForTimeout(4000);
    } else {
      await searchPage.goto('https://adstransparency.google.com/?region=any', {
        waitUntil: 'domcontentloaded', timeout: 60000
      });
      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);
      await searchPage.waitForTimeout(1600);

      const options = await searchPage.locator('[role="option"]').all();
      let matchedOption = null;
      for (const option of options) {
        const text = (await option.innerText()).trim();
        const firstLine = text.split('\n')[0].trim().toLowerCase();
        if (/\.(com|net|org|io|co|dojo|app|site|dev)/i.test(firstLine)) continue;
        if (firstLine.includes(query.toLowerCase())) {
          matchedOption = option;
          break;
        }
      }
      if (!matchedOption) {
        emitProgress(0, maxAdsToTest, `> ❌ No registered advertiser matching "${query}" found.`);
        return [];
      }

      hasClicked = true;
      await matchedOption.click();
      let waited = 0;
      while (!arId && waited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(1000);
        waited += 1000;
      }
      if (!arId) throw new Error('Failed to resolve advertiser ID.');
    }

    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to intercept ${maxAdsToTest} ads...`);
    let strikes = 0;
    let previousSize = adIds.size;
    while (adIds.size < maxAdsToTest && strikes < 3) {
      if (isCancelled()) throw new Error('Scan aborted by user.');
      await searchPage.mouse.wheel(0, 3000);
      await searchPage.waitForTimeout(3000);
      if (adIds.size === previousSize) strikes += 1;
      else {
        strikes = 0;
        previousSize = adIds.size;
        emitProgress(0, maxAdsToTest, `> ... intercepted ${adIds.size} ads so far...`);
      }
    }

    await searchPage.close();
    const idArray = [...adIds].slice(0, Math.max(0, Number(maxAdsToTest) || 0));
    if (!idArray.length) {
      emitProgress(0, 0, '> ℹ️ No active ads found for this target.');
      return [];
    }

    emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads. Running September-style broad extraction...`);

    const results = [];
    const globallyDiscovered = new Set();

    for (let i = 0; i < idArray.length; i += 1) {
      if (isCancelled()) throw new Error('Scan aborted by user.');
      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;
      const adPage = await context.newPage();
      const discovered = new Set();
      const videoMap = new Map();
      const frameEvidence = new Map();

      const requestHandler = req => {
        const reqUrl = req.url();
        for (const pkg of extractBroadPackages(reqUrl)) discovered.add(pkg);

        let frame = null;
        try { frame = req.frame(); } catch {}
        const isCreativeFrame = frame && frame !== adPage.mainFrame() && !(frame.url() || '').includes('/sadbundle/');
        if (isCreativeFrame) {
          const evidence = getFrameEvidence(frameEvidence, frame);
          for (const pkg of extractExplicitStorePackages(reqUrl)) evidence.packages.add(pkg);
          const media = parseMediaRequest(reqUrl);
          if (media) {
            mergeVideoAsset(videoMap, media);
            mergeVideoAsset(evidence.videos, media);
          }
        } else {
          const media = parseMediaRequest(reqUrl);
          if (media) mergeVideoAsset(videoMap, media);
        }
      };

      adPage.on('request', requestHandler);
      await adPage.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) route.abort();
        else route.continue();
      });

      try {
        try {
          await adPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch {
          // The September scanner deliberately scraped whatever had loaded even
          // after navigation timeout.
        }

        // Preserve the old fixed observation window. The adaptive scanners were
        // returning too early after the first signal and missing secondary apps.
        await adPage.waitForTimeout(5000);
        await adPage.waitForTimeout(3000);

        const frames = adPage.frames();
        for (const frame of frames) {
          try {
            const html = await frame.content();
            for (const pkg of extractBroadPackages(html)) discovered.add(pkg);
            for (const asset of extractVideoAssets(html)) {
              mergeVideoAsset(videoMap, asset);
              if (frame !== adPage.mainFrame() && !(frame.url() || '').includes('/sadbundle/')) {
                const evidence = getFrameEvidence(frameEvidence, frame);
                mergeVideoAsset(evidence.videos, asset);
                for (const pkg of extractExplicitStorePackages(html)) evidence.packages.add(pkg);
              }
            }
          } catch {}
        }

        const uniqueInAd = [...discovered];
        for (const pkg of uniqueInAd) globallyDiscovered.add(pkg);

        const attribution = buildSafeVideoAttribution(frameEvidence, videoMap);
        const videoAssets = [...videoMap.values()];
        if (videoAssets.length) {
          await persistCreativeVideos(adId, arId, attribution, videoAssets);
        }

        if (uniqueInAd.length) {
          for (const pkg of uniqueInAd) {
            results.push({
              creativeId: adId,
              package: pkg,
              discoveredPackages: uniqueInAd,
              videoAssets: attribution.packageAssets.get(pkg) || []
            });
            await onPackageFound(pkg);
          }
          emitProgress(
            i + 1,
            idArray.length,
            `> ✅ Ad ${i + 1}: discovered ${uniqueInAd.length} package${uniqueInAd.length === 1 ? '' : 's'}` +
            `${videoAssets.length ? ` · ${videoAssets.length} video${videoAssets.length === 1 ? '' : 's'}` : ''}`
          );
        } else {
          emitProgress(i + 1, idArray.length, `> ❌ Ad ${i + 1}: no valid package found.`);
        }
      } catch (error) {
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}: ${error.message || 'error'}; continuing.`);
      } finally {
        adPage.off('request', requestHandler);
        await adPage.close().catch(() => {});
      }
    }

    emitProgress(
      idArray.length,
      idArray.length,
      `> 🎉 Finished! ${globallyDiscovered.size} unique package${globallyDiscovered.size === 1 ? '' : 's'} discovered from ${idArray.length} ads.`
    );
    console.log(`📦 [Broad Scanner] ${idArray.length} ads -> ${globallyDiscovered.size} unique packages (${results.length} creative/package mappings).`);
    return results;
  } catch (error) {
    console.error('❌ Broad scanner ended:', error.message);
    emitProgress(0, maxAdsToTest, `> 🛑 SCAN ENDED: ${error.message}`);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  scanCompetitor,
  extractBroadPackages,
  extractExplicitStorePackages,
  buildSafeVideoAttribution
};
