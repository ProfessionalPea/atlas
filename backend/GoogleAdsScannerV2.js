const { chromium } = require('playwright');
const { Pool } = require('pg');
const {
  initializeIntelligenceFeatures,
  persistVideoAssets,
  getCreativeExtractionCache,
  persistCreativeExtractionCache,
  touchCreativeVideoAssets
} = require('./IntelligenceFeatures');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const videoPool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});
let videoDbReady = false;

const MAX_CREATIVE_WORKERS = 2;
const configuredWorkers = Math.max(
  1,
  Math.min(MAX_CREATIVE_WORKERS, Number(process.env.ATLAS_AD_SCAN_CONCURRENCY) || 2)
);
const CREATIVE_CHECKPOINTS_MS = [650, 1250, 2100, 3200, 4400, 5600];
const CREATIVE_SETTLE_AFTER_PACKAGE_MS = 1250;

async function ensureVideoDb() {
  if (videoDbReady) return;
  await initializeIntelligenceFeatures(videoPool);
  videoDbReady = true;
}

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const lower = pkg.toLowerCase();
  const validPrefixes = ['com.', 'io.', 'net.', 'org.', 'games.'];
  if (!validPrefixes.some(prefix => lower.startsWith(prefix))) return false;
  const blacklist = ['goog.', 'com.google.', 'com.android.', 'com.apple.', 'org.w3c.', 'org.apache.', 'io.github.'];
  if (blacklist.some(bad => lower.startsWith(bad))) return false;
  if (pkg.includes('_KNOWN_') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.png')) return false;
  return pkg.split('.').length >= 2;
}

function decodeForInspection(value) {
  let decoded = String(value || '');
  decoded = decoded
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

function normalizeUrl(value) {
  const decoded = decodeForInspection(value).trim();
  if (!decoded) return null;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return null;
}

function extractStorePackages(value) {
  const decoded = decodeForInspection(value);
  const found = new Set();
  const patterns = [
    /play\.google\.com\/store\/apps\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi,
    /market:\/\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      if (isValidPackage(match[1])) found.add(match[1].toLowerCase());
    }
  }
  return [...found];
}

function extractPackageKeys(value) {
  const decoded = decodeForInspection(value);
  const found = new Set();
  const regex = /(?:packageName|package_name|appId|app_id)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;
  for (const match of decoded.matchAll(regex)) {
    if (isValidPackage(match[1])) found.add(match[1].toLowerCase());
  }
  return [...found];
}

function youtubeIdFromText(value) {
  const text = decodeForInspection(value);
  const patterns = [
    /(?:youtube\.com\/(?:watch\?[^\s"'<>]*?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i,
    /ytimg\.com\/vi\/([A-Za-z0-9_-]{6,})\//i,
    /["']([A-Za-z0-9_-]{8,})["']\s*,\s*1\s*,\s*null\s*,\s*["']\/\/[^"']*googlevideo\.com\/videoplayback/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseMediaUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const source = parsed.searchParams.get('source') === 'youtube' || parsed.hostname.includes('googlevideo.com')
      ? 'youtube'
      : 'direct';
    const duration = Number(parsed.searchParams.get('dur'));
    const expire = Number(parsed.searchParams.get('expire'));
    return {
      source,
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
  if (asset.youtubeId) return `youtube:${asset.youtubeId}`;
  if (!asset.mediaUrl) return asset.thumbnailUrl ? `thumb:${asset.thumbnailUrl}` : null;
  try {
    const parsed = new URL(asset.mediaUrl);
    return `media:${parsed.origin}${parsed.pathname}`;
  } catch {
    return `media:${asset.mediaUrl.split('?')[0]}`;
  }
}

function mergeVideoAsset(map, incoming) {
  if (!incoming) return;
  const key = stableAssetKey(incoming);
  if (!key) return;
  const existing = map.get(key) || {};
  map.set(key, {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== '')),
    metadata: { ...(existing.metadata || {}), ...(incoming.metadata || {}) }
  });
}

function extractVideoAssets(value) {
  const text = decodeForInspection(value);
  const assets = new Map();
  const youtubeIds = new Set();

  for (const match of text.matchAll(/ytimg\.com\/vi\/([A-Za-z0-9_-]{6,})\/[^"'<>\s\\]+/gi)) {
    youtubeIds.add(match[1]);
    mergeVideoAsset(assets, {
      source: 'youtube',
      youtubeId: match[1],
      youtubeUrl: `https://www.youtube.com/watch?v=${match[1]}`,
      thumbnailUrl: `https://i1.ytimg.com/vi/${match[1]}/hqdefault.jpg`
    });
  }

  for (const pattern of [
    /(?:youtube\.com\/(?:watch\?[^\s"'<>]*?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/gi,
    /["']([A-Za-z0-9_-]{8,})["']\s*,\s*1\s*,\s*null\s*,\s*["']\/\/[^"']*googlevideo\.com\/videoplayback/gi
  ]) {
    for (const match of text.matchAll(pattern)) youtubeIds.add(match[1]);
  }

  for (const id of youtubeIds) {
    mergeVideoAsset(assets, {
      source: 'youtube',
      youtubeId: id,
      youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://i1.ytimg.com/vi/${id}/hqdefault.jpg`
    });
  }

  const mediaPatterns = [
    /<MediaFile\b([^>]*)>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/MediaFile>/gi,
    /<video\b[^>]*?\bsrc=["']([^"']+)["']/gi,
    /["'](\/\/[^"']*googlevideo\.com\/videoplayback\?[^"']+)["']/gi,
    /["'](https?:\/\/[^"']+\.(?:mp4|webm)(?:\?[^"']*)?)["']/gi
  ];

  for (let p = 0; p < mediaPatterns.length; p += 1) {
    for (const match of text.matchAll(mediaPatterns[p])) {
      const attrs = p === 0 ? match[1] : '';
      const rawUrl = p === 0 ? match[2] : match[1];
      const parsed = parseMediaUrl(rawUrl);
      if (!parsed) continue;

      const width = Number(attrs.match(/\bwidth=["']?(\d+)/i)?.[1]);
      const height = Number(attrs.match(/\bheight=["']?(\d+)/i)?.[1]);
      const mime = attrs.match(/\btype=["']([^"']+)/i)?.[1];
      mergeVideoAsset(assets, {
        ...parsed,
        width: Number.isFinite(width) && width > 0 ? width : null,
        height: Number.isFinite(height) && height > 0 ? height : null,
        mimeType: mime || parsed.mimeType || null
      });
    }
  }

  const ids = [...youtubeIds];
  if (ids.length === 1) {
    const youtubeId = ids[0];
    for (const [key, asset] of [...assets.entries()]) {
      if (asset.source !== 'youtube' || asset.youtubeId) continue;
      assets.delete(key);
      mergeVideoAsset(assets, {
        ...asset,
        youtubeId,
        youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
        thumbnailUrl: `https://i1.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
      });
    }
  }

  return [...assets.values()];
}

async function persistCreativeVideos(creativeId, packageNames, assets, advertiserId) {
  if (!assets.length || !packageNames.length) return;
  try {
    await ensureVideoDb();
    for (const packageName of packageNames) {
      await persistVideoAssets(videoPool, {
        creativeId,
        packageName,
        gameId: null,
        competitorId: null,
        advertiserId,
        assets
      });
    }
  } catch (error) {
    console.error('🎬 [Video] Failed to persist creative video:', creativeId, error.message);
  }
}

async function inspectCreativePage(adPage, primaryPackages, fallbackPackages, videoMap) {
  const creativeFrames = adPage.frames().filter(frame => {
    if (frame === adPage.mainFrame()) return false;
    return !(frame.url() || '').includes('/sadbundle/');
  });

  for (const frame of creativeFrames) {
    try {
      const html = await frame.content();
      extractStorePackages(html).forEach(pkg => primaryPackages.add(pkg));
      extractVideoAssets(html).forEach(asset => mergeVideoAsset(videoMap, asset));
    } catch {}
  }

  if (!primaryPackages.size) {
    for (const frame of creativeFrames) {
      try {
        const html = await frame.content();
        extractPackageKeys(html).forEach(pkg => primaryPackages.add(pkg));
      } catch {}
    }
  }

  try {
    const mainHtml = await adPage.mainFrame().content();
    extractVideoAssets(mainHtml).forEach(asset => mergeVideoAsset(videoMap, asset));
    if (!primaryPackages.size) extractStorePackages(mainHtml).forEach(pkg => fallbackPackages.add(pkg));
  } catch {}

  return {
    packageCount: primaryPackages.size || fallbackPackages.size,
    videoCount: videoMap.size,
    frameCount: creativeFrames.length
  };
}

async function waitForCreativeSignals(adPage, primaryPackages, fallbackPackages, videoMap) {
  const startedAt = Date.now();
  let packageDetectedAt = null;

  for (const checkpoint of CREATIVE_CHECKPOINTS_MS) {
    const elapsed = Date.now() - startedAt;
    if (checkpoint > elapsed) await adPage.waitForTimeout(checkpoint - elapsed);

    const state = await inspectCreativePage(adPage, primaryPackages, fallbackPackages, videoMap);
    if (state.packageCount > 0 && packageDetectedAt === null) packageDetectedAt = Date.now();

    if (packageDetectedAt !== null) {
      const settleElapsed = Date.now() - packageDetectedAt;
      if (settleElapsed < CREATIVE_SETTLE_AFTER_PACKAGE_MS) {
        await adPage.waitForTimeout(CREATIVE_SETTLE_AFTER_PACKAGE_MS - settleElapsed);
      }
      await inspectCreativePage(adPage, primaryPackages, fallbackPackages, videoMap);
      return;
    }
  }

  await inspectCreativePage(adPage, primaryPackages, fallbackPackages, videoMap);
}

async function discoverCreativeIds(searchPage, adIds, maxAdsToTest, isCancelled, emitProgress) {
  let previousSize = adIds.size;
  let idleRounds = 0;
  let rounds = 0;
  const maxIdleRounds = 7;

  while (adIds.size < maxAdsToTest && idleRounds < maxIdleRounds) {
    if (isCancelled()) break;
    rounds += 1;

    if (idleRounds === 2 || idleRounds === 5) {
      await searchPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    } else {
      await searchPage.mouse.wheel(0, idleRounds > 0 ? 4800 : 3600);
    }

    await searchPage.waitForTimeout(idleRounds > 0 ? 2100 : 1400);

    if (adIds.size > previousSize) {
      previousSize = adIds.size;
      idleRounds = 0;
    } else {
      idleRounds += 1;

      // A short reverse/forward movement often wakes Google's virtualized
      // lazy loader when a straight run to the bottom temporarily stalls.
      if (idleRounds === 3 || idleRounds === 6) {
        await searchPage.mouse.wheel(0, -1200);
        await searchPage.waitForTimeout(350);
        await searchPage.mouse.wheel(0, 5200);
        await searchPage.waitForTimeout(1200);
        if (adIds.size > previousSize) {
          previousSize = adIds.size;
          idleRounds = 0;
        }
      }
    }

    if (rounds % 8 === 0) {
      emitProgress(0, maxAdsToTest, `> 🎧 Discovered ${adIds.size} ads so far...`);
    }
  }

  return { exhausted: idleRounds >= maxIdleRounds, discovered: adIds.size };
}

async function createCreativeWorkerPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(30000);

  // Request events fire before abort, so media URLs remain observable while
  // heavy video/image/font/style bytes never need to download during scanning.
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) route.abort();
    else route.continue();
  });

  return page;
}

async function scanCompetitor(
  searchQuery,
  targetCountry,
  maxAdsToTest = 500,
  onProgress = () => {},
  onPackageFound = async () => {},
  isCancelled = () => false
) {
  const query = searchQuery.trim();
  console.log(`\n🚀 [Master Scanner] Starting full pipeline for: "${query}"`);
  const startTime = Date.now();

  const emitProgress = (current, total, logMsg) => {
    let timeRemaining = 'Calculating...';
    if (current > 0 && total > 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const remainingSeconds = Math.round((total - current) * (elapsedSeconds / current));
      if (remainingSeconds >= 0) {
        const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
        const secs = (remainingSeconds % 60).toString().padStart(2, '0');
        timeRemaining = `${mins}:${secs}`;
      }
    }
    onProgress({ currentAd: current, totalAds: total, timeRemaining, log: logMsg });
  };

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  const searchPage = await context.newPage();
  await searchPage.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) route.abort(); else route.continue();
  });

  try {
    searchPage.setDefaultTimeout(60000);
    searchPage.setDefaultNavigationTimeout(60000);
    let arId = null;
    const adIds = new Set();
    let hasClicked = false;

    emitProgress(0, maxAdsToTest, `> 🚀 Booting scanner for: "${query}"`);
    searchPage.on('response', async res => {
      try {
        const responseUrl = res.url();
        if (responseUrl.includes('SearchAdvertisers')) return;
        if (!hasClicked || !['xhr', 'fetch'].includes(res.request().resourceType())) return;

        if (!arId) {
          const postData = res.request().postData() || '';
          const match = responseUrl.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
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
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await searchPage.waitForTimeout(2500);
    } else {
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);
      await searchPage.goto('https://adstransparency.google.com/?region=any', { waitUntil: 'domcontentloaded', timeout: 45000 });
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
        if (firstLine.includes(query.toLowerCase())) { matchedOption = option; break; }
      }
      if (!matchedOption) {
        emitProgress(0, maxAdsToTest, `> ❌ No registered advertiser matching "${query}" found.`);
        await searchPage.close();
        return [];
      }
      hasClicked = true;
      await matchedOption.click();
      let waited = 0;
      while (!arId && waited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(750);
        waited += 750;
      }
      if (isCancelled()) throw new Error('Scan aborted by user.');
      if (!arId) {
        emitProgress(0, maxAdsToTest, '> ❌ Could not resolve advertiser ID.');
        await searchPage.close();
        return [];
      }
    }

    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to intercept up to ${maxAdsToTest} ads...`);
    const discovery = await discoverCreativeIds(searchPage, adIds, maxAdsToTest, isCancelled, emitProgress);
    if (isCancelled()) throw new Error('Scan aborted by user.');
    await searchPage.close();

    const idArray = [...adIds].slice(0, maxAdsToTest);
    if (!idArray.length) {
      emitProgress(0, 0, '> ℹ️ No active ads found for this target.');
      return [];
    }

    if (discovery.exhausted && idArray.length < maxAdsToTest) {
      emitProgress(0, idArray.length, `> ℹ️ Google stopped yielding new creatives at ${idArray.length}; scanning every ad discovered.`);
    } else {
      emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads! Moving to deep extraction...`);
    }

    let cacheMap = new Map();
    try {
      await ensureVideoDb();
      cacheMap = await getCreativeExtractionCache(videoPool, idArray);
    } catch (error) {
      console.warn('⚡ [Scan Cache] Cache unavailable; continuing with full extraction:', error.message);
    }

    const allFoundPackagesArray = [];
    let nextIndex = 0;
    let completed = 0;
    let cacheHits = 0;
    const workerCount = idArray.length >= 40
      ? Math.min(configuredWorkers, idArray.length)
      : 1;

    console.log(`⚡ [Scanner] Deep extraction using ${workerCount} worker${workerCount === 1 ? '' : 's'}; adaptive creative waits enabled.`);

    const runWorker = async (workerId) => {
      const adPage = await createCreativeWorkerPage(context);
      try {
        if (workerId > 0) await adPage.waitForTimeout(workerId * 500);

        while (!isCancelled()) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= idArray.length) break;

          const adId = idArray[i];
          const cached = cacheMap.get(adId);

          if (cached?.videoCheckedAt) {
            cacheHits += 1;
            try { await touchCreativeVideoAssets(videoPool, adId); } catch {}

            for (const pkg of cached.packageNames || []) {
              allFoundPackagesArray.push({ creativeId: adId, package: pkg, videoAssets: [], cached: true });
              await onPackageFound(pkg);
            }

            completed += 1;
            emitProgress(
              completed,
              idArray.length,
              `> ⚡ Ad ${i + 1}: Reused saved extraction${cached.packageNames?.length ? ` · ${cached.packageNames.length} package${cached.packageNames.length === 1 ? '' : 's'}` : ' · no mobile package'}`
            );
            continue;
          }

          const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;
          const primaryPackages = new Set();
          const fallbackPackages = new Set();
          const videoMap = new Map();

          await adPage.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => {});

          const requestHandler = req => {
            const requestUrl = req.url();
            const mediaAsset = /googlevideo\.com\/videoplayback|\.(?:mp4|webm)(?:\?|$)/i.test(requestUrl)
              ? parseMediaUrl(requestUrl)
              : null;
            if (mediaAsset) mergeVideoAsset(videoMap, mediaAsset);

            const packages = extractStorePackages(requestUrl);
            if (!packages.length) return;
            let frame = null;
            try { frame = req.frame(); } catch {}
            const frameUrl = frame ? frame.url() || '' : '';
            if (frameUrl.includes('/sadbundle/')) return;
            const bucket = frame && frame !== adPage.mainFrame() ? primaryPackages : fallbackPackages;
            packages.forEach(pkg => bucket.add(pkg));
          };

          adPage.on('request', requestHandler);

          try {
            console.log(`\n🟢 [DEBUG] [Ad ${i + 1}/${idArray.length}] ${url}`);
            try {
              await adPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch {
              console.log(`🟡 [DEBUG] [Ad ${i + 1}] Navigation timed out; inspecting loaded creative.`);
            }

            await waitForCreativeSignals(adPage, primaryPackages, fallbackPackages, videoMap);

            const uniqueInAd = [...(primaryPackages.size ? primaryPackages : fallbackPackages)];
            const videoAssets = [...videoMap.values()];

            if (uniqueInAd.length && videoAssets.length) {
              console.log(`🎬 [Video] Ad ${i + 1}: detected ${videoAssets.length} video asset(s).`);
              await persistCreativeVideos(adId, uniqueInAd, videoAssets, arId);
            }

            try {
              await persistCreativeExtractionCache(videoPool, {
                creativeId: adId,
                packageNames: uniqueInAd,
                videoCount: videoAssets.length
              });
              cacheMap.set(adId, {
                creativeId: adId,
                packageNames: uniqueInAd,
                videoCheckedAt: new Date().toISOString(),
                videoCount: videoAssets.length
              });
            } catch (error) {
              console.warn('⚡ [Scan Cache] Could not cache creative:', adId, error.message);
            }

            if (uniqueInAd.length) {
              for (const pkg of uniqueInAd) {
                allFoundPackagesArray.push({ creativeId: adId, package: pkg, videoAssets });
                await onPackageFound(pkg);
              }

              completed += 1;
              emitProgress(
                completed,
                idArray.length,
                `> ✅ Ad ${i + 1}: Found ${uniqueInAd.length} package${uniqueInAd.length === 1 ? '' : 's'}${videoAssets.length ? ` · 🎬 ${videoAssets.length} video` : ''}`
              );
            } else {
              completed += 1;
              emitProgress(completed, idArray.length, `> ❌ Ad ${i + 1}: No mobile package.`);
            }
          } catch (error) {
            completed += 1;
            console.error(`🔴 [DEBUG] [Ad ${i + 1}] Error:`, error.message);
            emitProgress(completed, idArray.length, `> ⚠️ Ad ${i + 1}: Error, continuing.`);
          } finally {
            adPage.off('request', requestHandler);
          }

          // A tiny gap keeps the two-worker mode from producing a sharp burst
          // while still being far quicker than the previous fixed 8s delay.
          await adPage.waitForTimeout(150 + workerId * 90);
        }
      } finally {
        await adPage.close().catch(() => {});
      }
    };

    await Promise.all(Array.from({ length: workerCount }, (_, workerId) => runWorker(workerId)));

    if (isCancelled()) throw new Error('Scan aborted by user.');

    emitProgress(
      idArray.length,
      idArray.length,
      `> 🎉 Finished! Extracted data mapped to DB.${cacheHits ? ` Reused ${cacheHits} saved creative extraction${cacheHits === 1 ? '' : 's'}.` : ''}`
    );
    return allFoundPackagesArray;
  } catch (error) {
    console.error('❌ Scanner crashed/aborted:', error.message);
    emitProgress(0, maxAdsToTest, `> 🛑 SCAN ENDED: ${error.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = {
  scanCompetitor,
  extractVideoAssets,
  youtubeIdFromText
};
