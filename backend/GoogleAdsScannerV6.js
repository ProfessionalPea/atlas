const { chromium } = require('playwright');
const { Pool } = require('pg');
const {
  initializeIntelligenceFeatures,
  touchCreativeVideoAssets
} = require('./IntelligenceFeatures');
const { extractVideoAssets } = require('./GoogleAdsScannerV2');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

// v6 keeps v5's strict ownership rules, but makes discovery materially more
// complete. In particular it inspects response bodies, tolerates escaped JSON,
// observes each creative for a minimum window, and invalidates the old v5 cache.
const EXTRACTION_VERSION = 6;
const MAX_CREATIVE_WORKERS = 2;
const configuredWorkers = Math.max(
  1,
  Math.min(MAX_CREATIVE_WORKERS, Number(process.env.ATLAS_AD_SCAN_CONCURRENCY) || 2)
);
const CREATIVE_CHECKPOINTS_MS = [700, 1400, 2400, 3600, 5000, 6500, 8000];
const CREATIVE_MIN_OBSERVATION_MS = 3000;
const CREATIVE_QUIET_AFTER_CHANGE_MS = 1700;
const MAX_RESPONSE_BODY_BYTES = 2_000_000;
let dbReady = false;

async function ensureDb() {
  if (dbReady) return;
  await initializeIntelligenceFeatures(pool);
  dbReady = true;
}

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const value = pkg.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)) return false;

  const lower = value.toLowerCase();
  const blacklist = [
    'goog.',
    'com.google.',
    'com.android.',
    'com.apple.',
    'org.w3c.',
    'org.apache.',
    'io.github.'
  ];
  if (blacklist.some(prefix => lower.startsWith(prefix))) return false;
  if (value.includes('_KNOWN_') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.png')) return false;
  return true;
}

function normalizePackage(pkg) {
  return isValidPackage(pkg) ? String(pkg).trim().toLowerCase() : null;
}

function decodeForInspection(value) {
  let decoded = String(value || '');
  decoded = decoded
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x22/gi, '"')
    .replace(/\\x27/gi, "'")
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");

  for (let i = 0; i < 3; i += 1) {
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
    /play\.google\.com\/store\/apps\/details\?[^"'<>\s]*?\bid=([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/gi,
    /market:\/\/details\?[^"'<>\s]*?\bid=([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/gi,
    /(?:play\.google\.com[^"'<>\s]{0,300}|market:\/\/details[^"'<>\s]{0,200})[?&]id=([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/gi
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const pkg = normalizePackage(match[1]);
      if (pkg) found.add(pkg);
    }
  }
  return [...found];
}

function extractPackageKeys(value) {
  const decoded = decodeForInspection(value);
  const found = new Set();
  const key = '(?:packageName|package_name|appId|app_id|androidPackageName|android_package_name|applicationId|application_id)';
  const valuePattern = '([A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+)';
  const patterns = [
    new RegExp(`${key}["']?\\s*[:=]\\s*["']${valuePattern}["']`, 'gi'),
    new RegExp(`["']${key}["']\\s*:\\s*["']${valuePattern}["']`, 'gi')
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const pkg = normalizePackage(match[1]);
      if (pkg) found.add(pkg);
    }
  }
  return [...found];
}

function parseMediaUrl(value) {
  const normalized = normalizeUrl(value);
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

function mergeVideoAsset(map, incoming) {
  if (!incoming) return;
  const key = stableAssetKey(incoming);
  if (!key) return;
  const existing = map.get(key) || {};
  map.set(key, {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== '')
    ),
    metadata: { ...(existing.metadata || {}), ...(incoming.metadata || {}) }
  });
}

function getFrameEvidence(frameEvidence, frame) {
  if (!frame) return null;
  let evidence = frameEvidence.get(frame);
  if (!evidence) {
    evidence = {
      storePackages: new Set(),
      metadataPackages: new Set(),
      visiblePackages: new Set(),
      videos: new Map(),
      url: frame.url() || ''
    };
    frameEvidence.set(frame, evidence);
  }
  return evidence;
}

async function collectVisibleStoreLinks(frame, evidence) {
  try {
    const links = await frame.locator('a[href*="play.google.com/store/apps/details"], a[href^="market://details"]').evaluateAll(nodes =>
      nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        return { href: node.getAttribute('href') || '', visible };
      })
    );

    for (const link of links) {
      for (const pkg of extractStorePackages(link.href)) {
        evidence.storePackages.add(pkg);
        if (link.visible) evidence.visiblePackages.add(pkg);
      }
    }
  } catch {}
}

function addDiscoveredPackages(target, values) {
  for (const value of values || []) {
    const pkg = normalizePackage(value);
    if (pkg) target.add(pkg);
  }
}

function absorbEvidenceText(value, frame, isCreativeFrame, storeCandidates, metadataCandidates, videoMap, frameEvidence) {
  if (!value) return;
  const storePackages = extractStorePackages(value);
  const metadataPackages = extractPackageKeys(value);
  addDiscoveredPackages(storeCandidates, storePackages);
  addDiscoveredPackages(metadataCandidates, metadataPackages);

  let evidence = null;
  if (isCreativeFrame && frame) {
    evidence = getFrameEvidence(frameEvidence, frame);
    addDiscoveredPackages(evidence.storePackages, storePackages);
    addDiscoveredPackages(evidence.metadataPackages, metadataPackages);
  }

  for (const asset of extractVideoAssets(value)) {
    mergeVideoAsset(videoMap, asset);
    if (evidence) mergeVideoAsset(evidence.videos, asset);
  }
}

async function inspectCreativePage(adPage, storeCandidates, metadataCandidates, videoMap, frameEvidence) {
  const frames = adPage.frames().filter(frame => {
    if (frame === adPage.mainFrame()) return false;
    return !(frame.url() || '').includes('/sadbundle/');
  });

  for (const frame of frames) {
    const evidence = getFrameEvidence(frameEvidence, frame);
    if (!evidence) continue;

    try {
      const html = await frame.content();
      absorbEvidenceText(html, frame, true, storeCandidates, metadataCandidates, videoMap, frameEvidence);
      await collectVisibleStoreLinks(frame, evidence);
      addDiscoveredPackages(storeCandidates, evidence.visiblePackages);
    } catch {}
  }

  try {
    const mainHtml = await adPage.mainFrame().content();
    absorbEvidenceText(mainHtml, adPage.mainFrame(), false, storeCandidates, metadataCandidates, videoMap, frameEvidence);
  } catch {}

  return {
    candidateCount: new Set([...storeCandidates, ...metadataCandidates]).size,
    storeCandidateCount: storeCandidates.size,
    metadataCandidateCount: metadataCandidates.size,
    videoCount: videoMap.size,
    frameCount: frames.length
  };
}

function evidenceSignature(storeCandidates, metadataCandidates, videoMap) {
  return [
    [...storeCandidates].sort().join(','),
    [...metadataCandidates].sort().join(','),
    videoMap.size
  ].join('|');
}

function frameIsDescendantOf(frame, ancestor) {
  let current = frame;
  while (current) {
    if (current === ancestor) return true;
    try { current = current.parentFrame(); } catch { return false; }
  }
  return false;
}

function resolveCreativePackage(storeCandidates, metadataCandidates, frameEvidence) {
  const discoveredPackages = [...new Set([...storeCandidates, ...metadataCandidates])];
  const visibleClaims = new Map();

  for (const [frame, evidence] of frameEvidence.entries()) {
    for (const pkg of evidence.visiblePackages) {
      if (!visibleClaims.has(pkg)) visibleClaims.set(pkg, new Set());
      visibleClaims.get(pkg).add(frame);
    }
  }

  if (visibleClaims.size === 1) {
    const [[packageName, frames]] = [...visibleClaims.entries()];
    return {
      packageName,
      confidence: 'high',
      reason: 'visible_play_store_cta',
      winningFrames: [...frames],
      storeCandidates: [...storeCandidates],
      metadataCandidates: [...metadataCandidates],
      discoveredPackages
    };
  }

  if (visibleClaims.size > 1) {
    return {
      packageName: null,
      confidence: 'none',
      reason: 'multiple_visible_play_store_ctas',
      winningFrames: [],
      storeCandidates: [...storeCandidates],
      metadataCandidates: [...metadataCandidates],
      discoveredPackages
    };
  }

  const frameClaims = new Map();
  for (const [frame, evidence] of frameEvidence.entries()) {
    if (evidence.storePackages.size !== 1) continue;
    const [pkg] = [...evidence.storePackages];
    if (!frameClaims.has(pkg)) frameClaims.set(pkg, new Set());
    frameClaims.get(pkg).add(frame);
  }

  if (frameClaims.size === 1) {
    const [[packageName, frames]] = [...frameClaims.entries()];
    return {
      packageName,
      confidence: 'medium',
      reason: 'single_store_package_in_creative_frame',
      winningFrames: [...frames],
      storeCandidates: [...storeCandidates],
      metadataCandidates: [...metadataCandidates],
      discoveredPackages
    };
  }

  if (storeCandidates.size === 1) {
    return {
      packageName: [...storeCandidates][0],
      confidence: 'low',
      reason: 'single_store_candidate_fallback',
      winningFrames: [],
      storeCandidates: [...storeCandidates],
      metadataCandidates: [...metadataCandidates],
      discoveredPackages
    };
  }

  if (storeCandidates.size === 0 && metadataCandidates.size === 1) {
    return {
      packageName: [...metadataCandidates][0],
      confidence: 'low',
      reason: 'single_metadata_package_fallback',
      winningFrames: [],
      storeCandidates: [],
      metadataCandidates: [...metadataCandidates],
      discoveredPackages
    };
  }

  return {
    packageName: null,
    confidence: 'none',
    reason: discoveredPackages.length > 1 ? 'multiple_packages_discovered' : 'no_package_candidate',
    winningFrames: [],
    storeCandidates: [...storeCandidates],
    metadataCandidates: [...metadataCandidates],
    discoveredPackages
  };
}

function collectAttributedVideos(resolution, frameEvidence) {
  const attributed = new Map();
  if (!resolution.packageName || !resolution.winningFrames.length) return attributed;

  for (const [frame, evidence] of frameEvidence.entries()) {
    if (!resolution.winningFrames.some(winner => frameIsDescendantOf(frame, winner))) continue;
    for (const asset of evidence.videos.values()) mergeVideoAsset(attributed, asset);
  }
  return attributed;
}

async function waitForCreativeSignals(adPage, storeCandidates, metadataCandidates, videoMap, frameEvidence) {
  const startedAt = Date.now();
  let lastSignature = '';
  let lastEvidenceChangeAt = startedAt;

  for (const checkpoint of CREATIVE_CHECKPOINTS_MS) {
    const elapsed = Date.now() - startedAt;
    if (checkpoint > elapsed) await adPage.waitForTimeout(checkpoint - elapsed);

    const state = await inspectCreativePage(
      adPage,
      storeCandidates,
      metadataCandidates,
      videoMap,
      frameEvidence
    );

    const signature = evidenceSignature(storeCandidates, metadataCandidates, videoMap);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastEvidenceChangeAt = Date.now();
    }

    const observedFor = Date.now() - startedAt;
    const quietFor = Date.now() - lastEvidenceChangeAt;
    if (
      state.candidateCount > 0 &&
      observedFor >= CREATIVE_MIN_OBSERVATION_MS &&
      quietFor >= CREATIVE_QUIET_AFTER_CHANGE_MS
    ) {
      return;
    }
  }

  await inspectCreativePage(adPage, storeCandidates, metadataCandidates, videoMap, frameEvidence);
}

async function getCacheMap(creativeIds) {
  await ensureDb();
  if (!creativeIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT creative_id, package_names, video_checked_at, last_video_count, extraction_version
     FROM creative_extraction_cache
     WHERE creative_id = ANY($1::text[])`,
    [creativeIds]
  );

  return new Map(rows.map(row => {
    const current = Number(row.extraction_version) === EXTRACTION_VERSION;
    const packages = current && Array.isArray(row.package_names)
      ? [...new Set(row.package_names.map(normalizePackage).filter(Boolean))]
      : [];
    return [row.creative_id, {
      creativeId: row.creative_id,
      packageNames: packages,
      videoCheckedAt: current ? row.video_checked_at : null,
      videoCount: Number(row.last_video_count) || 0,
      extractionVersion: Number(row.extraction_version) || 0
    }];
  }));
}

async function clearCreativeDerivedData(creativeId) {
  await ensureDb();
  await pool.query('DELETE FROM ad_video_links WHERE creative_id = $1', [creativeId]);
}

async function persistAsset(asset) {
  const key = stableAssetKey(asset);
  if (!key) return null;
  const source = asset.youtubeId || asset.source === 'youtube' ? 'youtube' : 'direct';
  const youtubeId = asset.youtubeId || null;
  const youtubeUrl = youtubeId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`
    : normalizeUrl(asset.youtubeUrl);
  const thumbnailUrl = normalizeUrl(asset.thumbnailUrl);
  const mediaUrl = normalizeUrl(asset.mediaUrl);
  const expiresAt = asset.mediaUrlExpiresAt ? new Date(asset.mediaUrlExpiresAt) : null;

  const { rows } = await pool.query(
    `INSERT INTO video_assets (
       asset_key, source, youtube_id, youtube_url, thumbnail_url, media_url,
       media_url_expires_at, mime_type, duration_seconds, width, height,
       metadata, first_seen_at, last_seen_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now(),now())
     ON CONFLICT (asset_key) DO UPDATE SET
       source = EXCLUDED.source,
       youtube_id = COALESCE(EXCLUDED.youtube_id, video_assets.youtube_id),
       youtube_url = COALESCE(EXCLUDED.youtube_url, video_assets.youtube_url),
       thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, video_assets.thumbnail_url),
       media_url = COALESCE(EXCLUDED.media_url, video_assets.media_url),
       media_url_expires_at = COALESCE(EXCLUDED.media_url_expires_at, video_assets.media_url_expires_at),
       mime_type = COALESCE(EXCLUDED.mime_type, video_assets.mime_type),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds, video_assets.duration_seconds),
       width = COALESCE(EXCLUDED.width, video_assets.width),
       height = COALESCE(EXCLUDED.height, video_assets.height),
       metadata = video_assets.metadata || EXCLUDED.metadata,
       last_seen_at = now()
     RETURNING id`,
    [
      key,
      source,
      youtubeId,
      youtubeUrl,
      thumbnailUrl,
      mediaUrl,
      Number.isNaN(expiresAt?.getTime?.()) ? null : expiresAt,
      asset.mimeType || null,
      Number.isFinite(Number(asset.durationSeconds)) ? Number(asset.durationSeconds) : null,
      Number.isFinite(Number(asset.width)) ? Number(asset.width) : null,
      Number.isFinite(Number(asset.height)) ? Number(asset.height) : null,
      JSON.stringify(asset.metadata || {})
    ]
  );
  return rows[0]?.id || null;
}

async function persistCreativeVideos(creativeId, advertiserId, packageName, allVideos, attributedVideos) {
  await clearCreativeDerivedData(creativeId);
  if (!allVideos.size) return;

  const attributedKeys = new Set(attributedVideos.keys());
  const creativeUrl = advertiserId
    ? `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=any`
    : null;

  for (const [key, asset] of allVideos.entries()) {
    const assetId = await persistAsset(asset);
    if (!assetId) continue;
    const assignedPackage = packageName && attributedKeys.has(key) ? packageName : '';

    await pool.query(
      `INSERT INTO ad_video_links (
         asset_id, creative_id, package_name, game_id, competitor_id,
         creative_url, first_seen_at, last_seen_at
       )
       VALUES ($1,$2,$3,NULL,NULL,$4,now(),now())
       ON CONFLICT (asset_id, creative_id, package_name) DO UPDATE SET
         game_id = NULL,
         competitor_id = NULL,
         creative_url = COALESCE(EXCLUDED.creative_url, ad_video_links.creative_url),
         last_seen_at = now()`,
      [assetId, creativeId, assignedPackage, creativeUrl]
    );
  }
}

async function persistCache(creativeId, resolution, videoCount) {
  await ensureDb();

  const cachePackages =
    resolution.packageName &&
    resolution.discoveredPackages.length === 1 &&
    resolution.discoveredPackages[0] === resolution.packageName
      ? [resolution.packageName]
      : [];

  await pool.query(
    `INSERT INTO creative_extraction_cache (
       creative_id, package_names, video_checked_at, last_deep_scanned_at,
       last_video_count, extraction_version
     )
     VALUES ($1,$2::jsonb,now(),now(),$3,$4)
     ON CONFLICT (creative_id) DO UPDATE SET
       package_names = EXCLUDED.package_names,
       video_checked_at = now(),
       last_deep_scanned_at = now(),
       last_video_count = EXCLUDED.last_video_count,
       extraction_version = EXCLUDED.extraction_version`,
    [creativeId, JSON.stringify(cachePackages), Math.max(0, Number(videoCount) || 0), EXTRACTION_VERSION]
  );
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
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    // Keep stylesheets: visible CTA detection relies on real computed styles.
    if (['image', 'media', 'font'].includes(type)) route.abort();
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
  console.log(`\n🚀 [Master Scanner v6] Starting evidence-recovery pipeline for: "${query}"`);
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
    if (['image', 'media', 'font'].includes(type)) route.abort();
    else route.continue();
  });

  try {
    searchPage.setDefaultTimeout(60000);
    searchPage.setDefaultNavigationTimeout(60000);
    let advertiserId = null;
    const adIds = new Set();
    let hasClicked = false;

    emitProgress(0, maxAdsToTest, `> 🚀 Booting scanner for: "${query}"`);
    searchPage.on('response', async res => {
      try {
        const responseUrl = res.url();
        if (responseUrl.includes('SearchAdvertisers')) return;
        if (!hasClicked || !['xhr', 'fetch'].includes(res.request().resourceType())) return;

        if (!advertiserId) {
          const postData = res.request().postData() || '';
          const match = responseUrl.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
          if (match) advertiserId = match[1];
        }
        const text = await res.text();
        if (!advertiserId) advertiserId = text.match(/(AR[0-9]{15,})/)?.[1] || null;
        for (const match of text.matchAll(/"(CR[0-9]+)"/g)) adIds.add(match[1]);
      } catch {}
    });

    if (/^AR[0-9]{15,}$/i.test(query)) {
      advertiserId = query.toUpperCase();
      hasClicked = true;
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${advertiserId}?region=any`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      await searchPage.waitForTimeout(2500);
    } else {
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);
      await searchPage.goto('https://adstransparency.google.com/?region=any', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);
      await searchPage.waitForTimeout(1600);

      const options = await searchPage.locator('[role="option"]').all();
      let matchedOption = null;
      for (const option of options) {
        const optionText = (await option.innerText()).trim();
        const firstLine = optionText.split('\n')[0].trim().toLowerCase();
        if (/\.(com|net|org|io|co|dojo|app|site|dev)/i.test(firstLine)) continue;
        if (firstLine.includes(query.toLowerCase())) {
          matchedOption = option;
          break;
        }
      }

      if (!matchedOption) {
        emitProgress(0, maxAdsToTest, `> ❌ No registered advertiser matching "${query}" found.`);
        await searchPage.close();
        return [];
      }

      hasClicked = true;
      await matchedOption.click();
      let waited = 0;
      while (!advertiserId && waited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(750);
        waited += 750;
      }
      if (isCancelled()) throw new Error('Scan aborted by user.');
      if (!advertiserId) {
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
      emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads! Discovering advertised packages...`);
    }

    let cacheMap = new Map();
    try {
      cacheMap = await getCacheMap(idArray);
    } catch (error) {
      console.warn('⚡ [Scan Cache] Cache unavailable; continuing with full extraction:', error.message);
    }

    const results = [];
    let nextIndex = 0;
    let completed = 0;
    let cacheHits = 0;
    let ownerResolved = 0;
    let packageDiscoveryOnly = 0;
    let noPackage = 0;
    const workerCount = idArray.length >= 40 ? Math.min(configuredWorkers, idArray.length) : 1;

    console.log(`⚡ [Scanner v6] Deep extraction using ${workerCount} worker${workerCount === 1 ? '' : 's'}.`);

    const runWorker = async workerId => {
      const adPage = await createCreativeWorkerPage(context);
      try {
        if (workerId > 0) await adPage.waitForTimeout(workerId * 500);

        while (!isCancelled()) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= idArray.length) break;

          const creativeId = idArray[i];
          const cached = cacheMap.get(creativeId);
          if (cached?.videoCheckedAt && cached.packageNames.length === 1) {
            cacheHits += 1;
            try { await touchCreativeVideoAssets(pool, creativeId); } catch {}
            const packageName = cached.packageNames[0];
            results.push({
              creativeId,
              package: packageName,
              discoveredPackages: [packageName],
              storeCandidatePackages: [packageName],
              metadataCandidatePackages: [],
              resolutionConfidence: 'cached',
              resolutionReason: 'v6_single_package_cache',
              candidatePackages: [packageName]
            });
            await onPackageFound(packageName);
            ownerResolved += 1;
            completed += 1;
            emitProgress(completed, idArray.length, `> ⚡ Ad ${i + 1}: Reused ${packageName}`);
            continue;
          }

          const url = `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=any`;
          const storeCandidates = new Set();
          const metadataCandidates = new Set();
          const videoMap = new Map();
          const frameEvidence = new Map();
          const pendingResponseInspections = new Set();

          await clearCreativeDerivedData(creativeId).catch(() => {});
          await adPage.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => {});

          const requestHandler = request => {
            const requestUrl = request.url();
            let frame = null;
            try { frame = request.frame(); } catch {}
            const isCreativeFrame = frame && frame !== adPage.mainFrame() && !(frame.url() || '').includes('/sadbundle/');

            absorbEvidenceText(requestUrl, frame, isCreativeFrame, storeCandidates, metadataCandidates, videoMap, frameEvidence);

            if (/googlevideo\.com\/videoplayback|\.(?:mp4|webm)(?:\?|$)/i.test(requestUrl)) {
              const asset = parseMediaUrl(requestUrl);
              if (asset) {
                mergeVideoAsset(videoMap, asset);
                if (isCreativeFrame) mergeVideoAsset(getFrameEvidence(frameEvidence, frame).videos, asset);
              }
            }
          };

          const responseHandler = response => {
            const request = response.request();
            const type = request.resourceType();
            if (!['document', 'xhr', 'fetch', 'script'].includes(type)) return;

            const headers = response.headers();
            const length = Number(headers['content-length'] || 0);
            if (Number.isFinite(length) && length > MAX_RESPONSE_BODY_BYTES) return;

            const job = (async () => {
              const body = await response.text();
              if (!body || body.length > MAX_RESPONSE_BODY_BYTES) return;
              let frame = null;
              try { frame = request.frame(); } catch {}
              const isCreativeFrame = frame && frame !== adPage.mainFrame() && !(frame.url() || '').includes('/sadbundle/');
              absorbEvidenceText(body, frame, isCreativeFrame, storeCandidates, metadataCandidates, videoMap, frameEvidence);
            })().catch(() => {}).finally(() => pendingResponseInspections.delete(job));
            pendingResponseInspections.add(job);
          };

          adPage.on('request', requestHandler);
          adPage.on('response', responseHandler);

          try {
            console.log(`\n🧭 [Resolver v6] [Ad ${i + 1}/${idArray.length}] ${url}`);
            try {
              await adPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch {
              console.log(`🟡 [Resolver v6] [Ad ${i + 1}] Navigation timed out; inspecting loaded creative.`);
            }

            await waitForCreativeSignals(adPage, storeCandidates, metadataCandidates, videoMap, frameEvidence);
            if (pendingResponseInspections.size) {
              await Promise.allSettled([...pendingResponseInspections]);
            }
            await inspectCreativePage(adPage, storeCandidates, metadataCandidates, videoMap, frameEvidence);

            const resolution = resolveCreativePackage(storeCandidates, metadataCandidates, frameEvidence);
            const attributedVideos = collectAttributedVideos(resolution, frameEvidence);

            await persistCreativeVideos(
              creativeId,
              advertiserId,
              resolution.packageName,
              videoMap,
              attributedVideos
            );
            await persistCache(creativeId, resolution, videoMap.size);

            const preview = resolution.discoveredPackages.slice(0, 6).join(', ');
            console.log(
              `🧭 [Resolver v6] ${creativeId}: ${resolution.discoveredPackages.length} package(s)` +
              `${preview ? ` [${preview}]` : ''} -> owner ` +
              `${resolution.packageName || 'UNRESOLVED'} (${resolution.reason})`
            );

            if (resolution.discoveredPackages.length > 0) {
              results.push({
                creativeId,
                package: resolution.packageName,
                discoveredPackages: resolution.discoveredPackages,
                storeCandidatePackages: resolution.storeCandidates,
                metadataCandidatePackages: resolution.metadataCandidates,
                resolutionConfidence: resolution.confidence,
                resolutionReason: resolution.reason,
                candidatePackages: resolution.discoveredPackages,
                videoAssets: [...attributedVideos.values()]
              });

              for (const pkg of resolution.discoveredPackages) {
                await onPackageFound(pkg);
              }

              if (resolution.packageName) ownerResolved += 1;
              else packageDiscoveryOnly += 1;

              completed += 1;
              emitProgress(
                completed,
                idArray.length,
                resolution.packageName
                  ? `> ✅ Ad ${i + 1}: ${resolution.packageName} · ${resolution.discoveredPackages.length} package${resolution.discoveredPackages.length === 1 ? '' : 's'} discovered` +
                    `${attributedVideos.size ? ` · 🎬 ${attributedVideos.size} attributed video${attributedVideos.size === 1 ? '' : 's'}` : ''}`
                  : `> 🧭 Ad ${i + 1}: found ${resolution.discoveredPackages.length} game package${resolution.discoveredPackages.length === 1 ? '' : 's'} · no single primary game confirmed`
              );
            } else {
              noPackage += 1;
              completed += 1;
              emitProgress(completed, idArray.length, `> ⚪ Ad ${i + 1}: no package evidence found`);
            }
          } catch (error) {
            completed += 1;
            console.error(`🔴 [Resolver v6] [Ad ${i + 1}] Error:`, error.message);
            emitProgress(completed, idArray.length, `> ⚠️ Ad ${i + 1}: Error, continuing.`);
          } finally {
            adPage.off('request', requestHandler);
            adPage.off('response', responseHandler);
          }

          await adPage.waitForTimeout(150 + workerId * 90);
        }
      } finally {
        await adPage.close().catch(() => {});
      }
    };

    await Promise.all(Array.from({ length: workerCount }, (_, workerId) => runWorker(workerId)));
    if (isCancelled()) throw new Error('Scan aborted by user.');

    const uniquePackages = new Set(results.flatMap(entry => entry.discoveredPackages || []));
    emitProgress(
      idArray.length,
      idArray.length,
      `> 🎉 Finished! ${uniquePackages.size} unique package${uniquePackages.size === 1 ? '' : 's'} discovered across ${results.length} creatives; ` +
      `${ownerResolved} creative owner${ownerResolved === 1 ? '' : 's'} resolved, ${packageDiscoveryOnly} multi-package creative${packageDiscoveryOnly === 1 ? '' : 's'} kept for discovery only, ${noPackage} with no package evidence.` +
      `${cacheHits ? ` Reused ${cacheHits} v6 cache entr${cacheHits === 1 ? 'y' : 'ies'}.` : ''}`
    );
    return results;
  } catch (error) {
    console.error('❌ Scanner v6 crashed/aborted:', error.message);
    emitProgress(0, maxAdsToTest, `> 🛑 SCAN ENDED: ${error.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = {
  scanCompetitor,
  resolveCreativePackage,
  extractStorePackages,
  extractPackageKeys,
  isValidPackage,
  decodeForInspection
};
