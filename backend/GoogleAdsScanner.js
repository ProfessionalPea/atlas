const { chromium } = require('playwright');
const { Pool } = require('pg');
const crypto = require('crypto');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const videoPool = cleanConnectionString
  ? new Pool({ connectionString: cleanConnectionString, ssl: { rejectUnauthorized: false } })
  : null;

let videoTablesReady = false;
let videoTablesPromise = null;

async function ensureVideoTables() {
  if (!videoPool || videoTablesReady) return;
  if (videoTablesPromise) return videoTablesPromise;

  videoTablesPromise = videoPool.query(`
    CREATE TABLE IF NOT EXISTS video_assets (
      id BIGSERIAL PRIMARY KEY,
      asset_key TEXT UNIQUE NOT NULL,
      asset_type TEXT NOT NULL,
      youtube_id TEXT,
      youtube_url TEXT,
      media_url TEXT,
      thumbnail_url TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      duration_seconds NUMERIC(10,3),
      source_host TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ad_video_assets (
      id BIGSERIAL PRIMARY KEY,
      creative_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      video_asset_id BIGINT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      transparency_url TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (creative_id, package_name, video_asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_assets_youtube_id
      ON video_assets(youtube_id)
      WHERE youtube_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_ad_video_assets_package
      ON ad_video_assets(package_name, last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ad_video_assets_creative
      ON ad_video_assets(creative_id, last_seen_at DESC);
  `).then(() => {
    videoTablesReady = true;
  }).catch((error) => {
    videoTablesPromise = null;
    console.error('⚠️ [Video Library] Failed to initialize video tables:', error.message);
  });

  return videoTablesPromise;
}

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const lower = pkg.toLowerCase();

  const validPrefixes = ['com.', 'io.', 'net.', 'org.', 'games.'];
  if (!validPrefixes.some(prefix => lower.startsWith(prefix))) return false;

  const blacklist = [
    'goog.', 'com.google.', 'com.android.', 'com.apple.',
    'org.w3c.', 'org.apache.', 'io.github.'
  ];
  if (blacklist.some(bad => lower.startsWith(bad))) return false;

  if (pkg.includes('_KNOWN_') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.png')) {
    return false;
  }

  const segments = pkg.split('.');
  if (segments.length < 2) return false;

  return true;
}

function decodeForStoreInspection(value) {
  let decoded = String(value || '');

  // Redirect URLs are often encoded once or twice by Google Ads.
  for (let i = 0; i < 2; i++) {
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

function extractStorePackages(value) {
  const decoded = decodeForStoreInspection(value);
  const found = new Set();

  // Only trust explicit Google Play / market destinations. The old generic
  // dotted-string scraper could pick up package names belonging to unrelated
  // advertiser metadata, which is why one creative sometimes "found" 10+ apps.
  const patterns = [
    /play\.google\.com\/store\/apps\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi,
    /market:\/\/details\?[^"'<>\s]*?\bid=([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      // Normalize casing so the same app can never be stored as two different
      // package_name rows just because two ads capitalized it differently.
      if (isValidPackage(match[1])) found.add(match[1].toLowerCase());
    }
  }

  return [...found];
}

function extractPackageKeys(value) {
  const decoded = decodeForStoreInspection(value);
  const found = new Set();
  const jsonKeyRegex = /(?:packageName|package_name|appId|app_id)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;

  for (const match of decoded.matchAll(jsonKeyRegex)) {
    if (isValidPackage(match[1])) found.add(match[1].toLowerCase());
  }

  return [...found];
}

function decodeVideoEvidence(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeMediaUrl(value) {
  let url = decodeVideoEvidence(value).trim().replace(/^['"]|['"]$/g, '');
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseDurationFromUrl(mediaUrl) {
  const parsed = safeUrl(mediaUrl);
  if (!parsed) return null;
  const value = Number(parsed.searchParams.get('dur'));
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null;
}

function extractVideoAssets(evidenceParts, creativeId) {
  const raw = decodeVideoEvidence((evidenceParts || []).filter(Boolean).join('\n'));
  if (!raw.trim()) return [];

  const youtubeIds = new Set();
  const youtubePatterns = [
    /(?:i\d+\.)?ytimg\.com\/vi\/([A-Za-z0-9_-]{11})(?:\/|\?|['"<\s])/gi,
    /youtube\.com\/(?:watch\?[^"'<>\s]*?v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/gi,
    /youtu\.be\/([A-Za-z0-9_-]{11})/gi,
  ];
  for (const pattern of youtubePatterns) {
    for (const match of raw.matchAll(pattern)) youtubeIds.add(match[1]);
  }

  const mediaCandidates = [];

  // VAST MediaFile entries expose the strongest direct-media metadata.
  const vastRegex = /<MediaFile\b([^>]*)>(?:<!\[CDATA\[)?\s*([^<\]]+?)(?:\]\]>)?\s*<\/MediaFile>/gi;
  for (const match of raw.matchAll(vastRegex)) {
    const attrs = match[1] || '';
    const mediaUrl = normalizeMediaUrl(match[2]);
    if (!mediaUrl) continue;
    const width = Number((attrs.match(/\bwidth=["']?(\d+)/i) || [])[1]) || null;
    const height = Number((attrs.match(/\bheight=["']?(\d+)/i) || [])[1]) || null;
    const mimeType = (attrs.match(/\btype=["']([^"']+)/i) || [])[1] || null;
    mediaCandidates.push({ mediaUrl, width, height, mimeType });
  }

  // Live video elements and serialized VAST often expose the same signed URL
  // through a different representation. Deduplication below collapses them.
  const srcRegex = /<video\b[^>]*\bsrc=["']([^"']+)["']/gi;
  for (const match of raw.matchAll(srcRegex)) {
    const mediaUrl = normalizeMediaUrl(match[1]);
    if (mediaUrl) mediaCandidates.push({ mediaUrl, width: null, height: null, mimeType: null });
  }

  const directUrlRegex = /(?:https?:)?\/\/[A-Za-z0-9._-]+\/(?:[^\s"'<>]*?(?:videoplayback|\.mp4|\.webm))(?:[^\s"'<>]*)/gi;
  for (const match of raw.matchAll(directUrlRegex)) {
    const mediaUrl = normalizeMediaUrl(match[0]);
    if (mediaUrl) mediaCandidates.push({ mediaUrl, width: null, height: null, mimeType: null });
  }

  const uniqueMedia = new Map();
  for (const item of mediaCandidates) {
    if (!uniqueMedia.has(item.mediaUrl)) uniqueMedia.set(item.mediaUrl, item);
  }

  const mediaRows = [...uniqueMedia.values()];
  const youtubeIdList = [...youtubeIds];
  const youtubeMedia = mediaRows.find(item => {
    const parsed = safeUrl(item.mediaUrl);
    return parsed?.searchParams.get('source') === 'youtube' || /googlevideo\.com$/i.test(parsed?.hostname || '');
  }) || null;

  const assets = youtubeIdList.map(youtubeId => ({
    assetKey: `youtube:${youtubeId}`,
    assetType: 'youtube',
    youtubeId,
    youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    mediaUrl: youtubeMedia?.mediaUrl || null,
    thumbnailUrl: `https://i1.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    mimeType: youtubeMedia?.mimeType || 'video/mp4',
    width: youtubeMedia?.width || null,
    height: youtubeMedia?.height || null,
    durationSeconds: youtubeMedia?.mediaUrl ? parseDurationFromUrl(youtubeMedia.mediaUrl) : null,
    sourceHost: youtubeMedia?.mediaUrl ? safeUrl(youtubeMedia.mediaUrl)?.hostname || 'youtube.com' : 'youtube.com'
  }));

  // A googlevideo playback URL with source=youtube is intentionally NOT saved
  // as a separate direct asset when a stable YouTube ID was found. Those URLs
  // are signed and expire; the permanent YouTube ID is the durable reference.
  for (let index = 0; index < mediaRows.length; index++) {
    const item = mediaRows[index];
    const parsed = safeUrl(item.mediaUrl);
    const looksYoutube = parsed?.searchParams.get('source') === 'youtube' || /googlevideo\.com$/i.test(parsed?.hostname || '');
    if (looksYoutube && youtubeIdList.length > 0) continue;

    let stableIdentity = item.mediaUrl;
    if (parsed && !/googlevideo\.com$/i.test(parsed.hostname)) {
      stableIdentity = `${parsed.origin}${parsed.pathname}`;
    } else if (looksYoutube) {
      stableIdentity = `${creativeId}:${index}`;
    }

    assets.push({
      assetKey: `direct:${crypto.createHash('sha256').update(stableIdentity).digest('hex')}`,
      assetType: 'direct',
      youtubeId: null,
      youtubeUrl: null,
      mediaUrl: item.mediaUrl,
      thumbnailUrl: null,
      mimeType: item.mimeType || (/\.webm(?:\?|$)/i.test(item.mediaUrl) ? 'video/webm' : 'video/mp4'),
      width: item.width || null,
      height: item.height || null,
      durationSeconds: parseDurationFromUrl(item.mediaUrl),
      sourceHost: parsed?.hostname || null
    });
  }

  const byKey = new Map();
  for (const asset of assets) {
    if (!byKey.has(asset.assetKey)) byKey.set(asset.assetKey, asset);
  }
  return [...byKey.values()];
}

async function persistVideoAssets(creativeId, packages, assets, transparencyUrl) {
  if (!videoPool || !creativeId || !Array.isArray(packages) || packages.length === 0 || !Array.isArray(assets) || assets.length === 0) return;
  await ensureVideoTables();
  if (!videoTablesReady) return;

  for (const asset of assets) {
    try {
      const { rows } = await videoPool.query(
        `INSERT INTO video_assets (
           asset_key, asset_type, youtube_id, youtube_url, media_url,
           thumbnail_url, mime_type, width, height, duration_seconds,
           source_host, first_seen_at, last_seen_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
         ON CONFLICT (asset_key) DO UPDATE SET
           youtube_url = COALESCE(EXCLUDED.youtube_url, video_assets.youtube_url),
           media_url = COALESCE(EXCLUDED.media_url, video_assets.media_url),
           thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, video_assets.thumbnail_url),
           mime_type = COALESCE(EXCLUDED.mime_type, video_assets.mime_type),
           width = COALESCE(EXCLUDED.width, video_assets.width),
           height = COALESCE(EXCLUDED.height, video_assets.height),
           duration_seconds = COALESCE(EXCLUDED.duration_seconds, video_assets.duration_seconds),
           source_host = COALESCE(EXCLUDED.source_host, video_assets.source_host),
           last_seen_at = now()
         RETURNING id`,
        [
          asset.assetKey,
          asset.assetType,
          asset.youtubeId,
          asset.youtubeUrl,
          asset.mediaUrl,
          asset.thumbnailUrl,
          asset.mimeType,
          asset.width,
          asset.height,
          asset.durationSeconds,
          asset.sourceHost
        ]
      );

      const videoAssetId = rows[0]?.id;
      if (!videoAssetId) continue;

      for (const pkg of packages) {
        await videoPool.query(
          `INSERT INTO ad_video_assets (
             creative_id, package_name, video_asset_id, transparency_url,
             first_seen_at, last_seen_at
           )
           VALUES ($1,$2,$3,$4,now(),now())
           ON CONFLICT (creative_id, package_name, video_asset_id) DO UPDATE SET
             transparency_url = COALESCE(EXCLUDED.transparency_url, ad_video_assets.transparency_url),
             last_seen_at = now()`,
          [creativeId, pkg, videoAssetId, transparencyUrl]
        );
      }
    } catch (error) {
      console.error(`⚠️ [Video Library] Failed to persist video for ${creativeId}:`, error.message);
    }
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
  const query = searchQuery.trim();
  console.log(`\n🚀 [Master Scanner] Starting full pipeline for: "${query}"`);

  const startTime = Date.now();
  const emitProgress = (current, total, logMsg) => {
    let timeRemaining = "Calculating...";
    if (current > 0 && total > 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const secondsPerAd = elapsedSeconds / current;
      const remainingSeconds = Math.round((total - current) * secondsPerAd);
      if (remainingSeconds >= 0) {
        const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
        const secs = (remainingSeconds % 60).toString().padStart(2, '0');
        timeRemaining = `${mins}:${secs}`;
      }
    }
    onProgress({ currentAd: current, totalAds: total, timeRemaining, log: logMsg });
  };

  console.log("🟢 [DEBUG] 1. Launching Headless Browser with Stealth Params...");
  let browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  });

  console.log("🟢 [DEBUG] 2. Creating Stealth Context...");
  let context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const searchPage = await context.newPage();

  console.log("🟢 [DEBUG] 3. Applying RAM Optimizations...");
  await searchPage.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'media', 'font'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    searchPage.setDefaultTimeout(60000);
    searchPage.setDefaultNavigationTimeout(60000);

    let arId = null;
    let adIds = new Set();
    let hasClicked = false;

    console.log("🟢 [DEBUG] 4. Booting network interception listeners...");
    emitProgress(0, maxAdsToTest, `> 🚀 Booting scanner for: "${query}"`);

    searchPage.on('response', async (res) => {
      try {
        const url = res.url();
        if (url.includes('SearchAdvertisers')) return;

        if (hasClicked && (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch')) {
          if (!arId) {
            const postData = res.request().postData() || '';
            const match = url.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
            if (match) {
              arId = match[1];
              console.log(`🟢 [DEBUG] [Network] Intercepted AR ID: ${arId}`);
            }
          }

          const text = await res.text();
          if (!arId) {
            const textMatch = text.match(/(AR[0-9]{15,})/);
            if (textMatch) {
              arId = textMatch[1];
              console.log(`🟢 [DEBUG] [Network] Found AR ID in response body: ${arId}`);
            }
          }

          const crMatches = [...text.matchAll(/"(CR[0-9]+)"/g)];
          crMatches.forEach(m => adIds.add(m[1]));
        }
      } catch (e) {}
    });

    const isDirectId = /^AR[0-9]{15,}$/i.test(query);

    if (isDirectId) {
      arId = query.toUpperCase();
      console.log(`🟢 [DEBUG] 5. Direct AR ID detected (${arId}). Bypassing search phase...`);
      emitProgress(0, maxAdsToTest, `> ✅ Direct ID detected: ${arId}. Bypassing search...`);
      hasClicked = true;

      console.log(`🟢 [DEBUG] 5A. Navigating to Advertiser page...`);
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      await searchPage.waitForTimeout(4000);
    } else {
      console.log(`🟢 [DEBUG] 5. Search query detected ("${query}"). Navigating to Google Ads Transparency search...`);
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);
      await searchPage.goto('https://adstransparency.google.com/?region=any', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });

      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);
      await searchPage.waitForTimeout(2000);

      const options = await searchPage.locator('[role="option"]').all();
      let matchedOption = null;

      for (const opt of options) {
        const text = (await opt.innerText()).trim();
        const firstLine = text.split('\n')[0].trim().toLowerCase();
        const cleanQuery = query.toLowerCase();

        if (/\.(com|net|org|io|co|dojo|app|site|dev)/i.test(firstLine)) continue;

        if (firstLine.includes(cleanQuery)) {
          matchedOption = opt;
          break;
        }
      }

      if (!matchedOption) {
        console.log(`🛑 [SCAN ABORT] No corporate advertiser matching "${query}" found.`);
        emitProgress(0, maxAdsToTest, `> ❌ No registered advertiser matching "${query}" found.`);
        await searchPage.close();
        return [];
      }

      hasClicked = true;
      await matchedOption.click();
      emitProgress(0, maxAdsToTest, `> 🖱️ Clicked advertiser. Sniffing network for AR ID...`);

      let timeWaited = 0;
      while (!arId && timeWaited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(1000);
        timeWaited += 1000;
      }

      if (isCancelled()) throw new Error('Scan aborted by user.');
      if (!arId) {
        console.log(`🛑 [SCAN ABORT] Failed to resolve Advertiser ID.`);
        emitProgress(0, maxAdsToTest, `> ❌ Could not resolve advertiser ID.`);
        await searchPage.close();
        return [];
      }

      console.log(`🟢 [DEBUG] 5E. Successfully locked onto Advertiser ID: ${arId}`);
      emitProgress(0, maxAdsToTest, `> ✅ Locked onto Advertiser ID: ${arId}`);
    }

    console.log("🟢 [DEBUG] 6. Entering scroll phase to trigger ad network requests...");
    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to intercept ${maxAdsToTest} ads...`);

    let strikes = 0;
    let previousSize = 0;

    while (adIds.size < maxAdsToTest && strikes < 3) {
      if (isCancelled()) {
        emitProgress(0, maxAdsToTest, '> 🛑 Abort signal received. Halting scroll...');
        break;
      }

      await searchPage.mouse.wheel(0, 3000);
      await searchPage.waitForTimeout(2500);

      if (adIds.size === previousSize) {
        strikes++;
        console.log(`🟡 [DEBUG] Scroll strike ${strikes}/3. Ad count unchanged at ${adIds.size}.`);
      } else {
        strikes = 0;
        previousSize = adIds.size;
        console.log(`🟢 [DEBUG] Intercepted ${adIds.size} ads so far...`);
        emitProgress(0, maxAdsToTest, `> ... intercepted ${adIds.size} ads so far...`);
      }
    }

    if (isCancelled()) throw new Error('Scan aborted by user.');

    await searchPage.close();
    console.log(`🟢 [DEBUG] Closed search page to free RAM.`);

    const idArray = Array.from(adIds).slice(0, maxAdsToTest);

    if (idArray.length === 0) {
      console.log(`ℹ️ [SCAN] Zero ads found for advertiser ${arId}.`);
      emitProgress(0, 0, `> ℹ️ No active ads found for this target.`);
      return [];
    }

    console.log(`🟢 [DEBUG] 7. Scroll phase complete. Moving to deep extraction loop...`);
    emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads! Moving to deep extraction...`);

    // Each entry is { creativeId, package } — one row per (ad, package) match,
    // so the caller can tell a genuinely new ad apart from one already logged.
    let allFoundPackagesArray = [];

    for (let i = 0; i < idArray.length; i++) {
      if (isCancelled()) {
        emitProgress(i + 1, idArray.length, '> 🛑 Abort signal received. Terminating deep extraction...');
        break;
      }

      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;

      const adPage = await context.newPage();
      const primaryPackages = new Set();
      const fallbackPackages = new Set();
      const videoRequestUrls = new Set();

      adPage.on('request', req => {
        const requestUrl = req.url();
        const resourceType = req.resourceType();
        if (resourceType === 'media' || /googlevideo\.com\/videoplayback|\.(?:mp4|webm)(?:\?|$)/i.test(requestUrl)) {
          videoRequestUrls.add(requestUrl);
        }

        const packages = extractStorePackages(requestUrl);
        if (packages.length === 0) return;

        let frame = null;
        try { frame = req.frame(); } catch {}

        // Google's SafeFrame ad sandbox loads a "sadbundle" companion resource
        // on every single ad view, regardless of which specific creative is
        // being inspected. Confirmed via logging: the same package kept
        // appearing from the same sadbundle URL across ten completely
        // different ads for one advertiser. Treat it as ad-infrastructure
        // noise, not part of the actual ad.
        const frameUrl = frame ? (frame.url() || '') : '';
        if (frameUrl.includes('/sadbundle/')) return;

        const isCreativeFrameRequest = Boolean(frame && frame !== adPage.mainFrame());

        const bucket = isCreativeFrameRequest ? primaryPackages : fallbackPackages;
        packages.forEach(pkg => bucket.add(pkg));
      });

      // Keep scripts/XHR alive, but block heavy visual assets. Media requests
      // are still observed by the request listener before they are aborted, so
      // Atlas can preserve the URL/metadata without downloading the full video.
      await adPage.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      try {
        console.log(`\n🟢 [DEBUG] 8. [Ad ${i + 1}/${idArray.length}] Navigating to: ${url}`);
        try {
          await adPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch {
          console.log(`🔴 [DEBUG] [Ad ${i + 1}] Page load timed out, proceeding with inspection...`);
        }

        // Give Google Ads' nested creative frames/network redirects enough time
        // to expose the destination before inspecting the creative iframe.
        await adPage.waitForTimeout(5000);
        await adPage.waitForTimeout(3000);

        const frames = adPage.frames();
        // Exclude the "sadbundle" SafeFrame companion resource for the same
        // reason as the request listener above — it's present on every ad
        // regardless of which creative is being viewed, and was confirmed to
        // consistently report the same package across unrelated ads.
        const creativeFrames = frames.filter(frame => {
          if (frame === adPage.mainFrame()) return false;
          const frameUrl = frame.url() || '';
          return !frameUrl.includes('/sadbundle/');
        });

        const creativeHtmlParts = [];

        // Highest-confidence source: explicit Play Store URLs inside the nested
        // creative frames. The same HTML also carries video_config/video_fields,
        // VAST MediaFile data and ytimg thumbnails for video creatives.
        for (const frame of creativeFrames) {
          try {
            const html = await frame.content();
            creativeHtmlParts.push(html);
            extractStorePackages(html).forEach(pkg => primaryPackages.add(pkg));
          } catch {}
        }

        // Some creatives expose the package as a JSON key rather than a visible
        // Play Store URL. Only inspect CHILD frames for this fallback; do not scan
        // the advertiser page's giant serialized metadata blob.
        if (primaryPackages.size === 0) {
          for (const html of creativeHtmlParts) {
            extractPackageKeys(html).forEach(pkg => primaryPackages.add(pkg));
          }
        }

        // Last-resort fallback: explicit Play Store URLs from the main page or
        // main-frame requests. We intentionally removed the old generic dotted-
        // string regex because it was the source of most multi-package pollution.
        let mainHtml = '';
        if (primaryPackages.size === 0) {
          try {
            mainHtml = await adPage.mainFrame().content();
            extractStorePackages(mainHtml).forEach(pkg => fallbackPackages.add(pkg));
          } catch {}
        }

        const uniqueInAd = [...(primaryPackages.size > 0 ? primaryPackages : fallbackPackages)];
        const videoAssets = extractVideoAssets(
          [...creativeHtmlParts, mainHtml, ...videoRequestUrls],
          adId
        );

        if (uniqueInAd.length > 0) {
          console.log(`🟢 [DEBUG] [Ad ${i + 1}] SUCCESS: Found ${uniqueInAd.length} packages:`, uniqueInAd);
          if (videoAssets.length > 0) {
            const youtubeCount = videoAssets.filter(asset => asset.assetType === 'youtube').length;
            console.log(`🎬 [Video Library] [Ad ${i + 1}] Found ${videoAssets.length} video asset(s)${youtubeCount ? ` (${youtubeCount} YouTube)` : ''}.`);
          }
          emitProgress(
            i + 1,
            idArray.length,
            videoAssets.length > 0
              ? `> 🎬 Ad ${i + 1}: Found ${uniqueInAd.length} packages + ${videoAssets.length} video${videoAssets.length === 1 ? '' : 's'}`
              : `> ✅ Ad ${i + 1}: Found ${uniqueInAd.length} packages`
          );

          await persistVideoAssets(adId, uniqueInAd, videoAssets, url);

          for (const pkg of uniqueInAd) {
            allFoundPackagesArray.push({ creativeId: adId, package: pkg, videoAssets });
            await onPackageFound(pkg);
          }
        } else {
          console.log(`🟡 [DEBUG] [Ad ${i + 1}] FAILURE: No valid packages found.`);
          emitProgress(i + 1, idArray.length, `> ❌ Ad ${i + 1}: No mobile package.`);
        }
      } catch (error) {
        console.error(`🔴 [DEBUG] [Ad ${i + 1}] Error:`, error.message);
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}: Error, continuing.`);
      } finally {
        await adPage.close();
        console.log(`🟢 [DEBUG] [Ad ${i + 1}] Closed ad tab to free RAM.`);
      }
    }

    console.log(`\n🟢 [DEBUG] 9. PIPELINE COMPLETE!`);
    emitProgress(idArray.length, idArray.length, `> 🎉 Finished! Extracted data mapped to DB.`);

    // Returns { creativeId, package, videoAssets }[]. Existing callers that only
    // use creativeId/package remain fully compatible.
    return allFoundPackagesArray;
  } catch (error) {
    console.error('❌ Scanner crashed/aborted:', error.message);
    emitProgress(0, maxAdsToTest, `> 🛑 SCAN ENDED: ${error.message}`);
    return [];
  } finally {
    console.log("🟢 [DEBUG] 10. Cleaning up & closing browser context...");
    await browser.close();
  }
}

module.exports = {
  scanCompetitor,
  extractVideoAssets,
  persistVideoAssets
};