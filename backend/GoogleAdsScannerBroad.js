const { chromium } = require('playwright');
const { Pool } = require('pg');
const {
  initializeIntelligenceFeatures,
  persistVideoAssets
} = require('./IntelligenceFeatures');
const { extractVideoAssets } = require('./GoogleAdsScannerV2');
const { isGoogleHost, classifyGoogleResponse, createBoundedQueue, waitForStableSignal } = require('./ScannerResilience');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const videoPool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
  statement_timeout: 15000,
  query_timeout: 18000
});
let videoDbReady = false;
let videoDbInitialization = null;

async function ensureVideoDb() {
  if (videoDbReady) return;
  if (!videoDbInitialization) {
    videoDbInitialization = initializeIntelligenceFeatures(videoPool)
      .then(() => { videoDbReady = true; })
      .finally(() => { videoDbInitialization = null; });
  }
  await videoDbInitialization;
}

const PACKAGE_BLACKLIST = [
  'com.google.',
  'com.android.',
  'com.apple.'
];

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const value = pkg.trim();
  if (!value || value.length > 255) return false;

  const lower = value.toLowerCase();
  // Atlas intentionally ingests Android package IDs in the com.* namespace only.
  if (!lower.startsWith('com.')) return false;
  if (PACKAGE_BLACKLIST.some(prefix => lower.startsWith(prefix))) return false;
  if (value.includes('_KNOWN_') || /\.(?:js|json|png|css|html?)$/i.test(lower)) return false;

  const segments = value.split('.');
  if (segments.length < 2) return false;
  if (!segments.every(segment => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) return false;

  return true;
}

function decodeForInspection(value) {
  let decoded = String(value || '');

  // Google frequently nests escaped JSON inside script and c-wiz initialization
  // payloads. Decode these representations iteratively so the same extractors
  // work on raw HTML, script text, response JSON and double-escaped payloads.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = decoded;
    decoded = decoded
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\(["'])/g, '$1')
      .replace(/\\[nrt]/g, ' ');

    try {
      const uriDecoded = decodeURIComponent(decoded);
      if (uriDecoded !== decoded) decoded = uriDecoded;
    } catch {}

    if (decoded === before) break;
  }

  return decoded;
}

function addPackage(set, value) {
  if (!isValidPackage(value)) return;
  set.add(String(value).trim().toLowerCase());
}

// This intentionally restores the September scanner's broad discovery model.
// An ad limit limits creatives inspected, not games discovered. One creative can
// contribute several package candidates.
function extractBroadPackages(value) {
  const decoded = decodeForInspection(value).slice(0, 5000000);
  const found = new Set();

  // Strong evidence: an actual Play Store or market destination.
  const destinationRegex = /(?:id=|id%3D|details\?id=|details%3Fid%3D|market:\/\/details\?id=)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi;
  for (const match of decoded.matchAll(destinationRegex)) addPackage(found, match[1]);

  // Structured evidence: app/package identifiers in JSON, JS objects or
  // initialization payloads. The same com.* rule applies to every field.
  const keyedRegex = /(?:packageName|package_name|appId|app_id|bundleId|bundle_id|androidPackageName|android_package_name|applicationId|application_id|applicationPackage|application_package|appPackage|app_package|appIdentifier|app_identifier|googlePlayAppId|storePackageName|store_package_name)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;
  for (const match of decoded.matchAll(keyedRegex)) addPackage(found, match[1]);

  // Broad evidence: quoted dotted identifiers, including the September model.
  const delimitedRegex = /["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})["']/g;
  for (const match of decoded.matchAll(delimitedRegex)) addPackage(found, match[1]);

  // Some c-wiz payloads surface the identifier as a bare token rather than a
  // quoted JSON string. Keep this pass namespace-filtered to limit hostnames.
  const bareDottedRegex = /\b([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,})\b/g;
  for (const match of decoded.matchAll(bareDottedRegex)) addPackage(found, match[1]);

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

const videoPersistenceQueue = createBoundedQueue(
  async job => persistCreativeVideos(job.creativeId, job.advertiserId, job.attribution, job.allAssets),
  {
    concurrency: 2,
    maxPending: 24,
    onError(error, job) {
      console.warn('[Broad Scanner] Queued video persistence failed for ' + job.creativeId + ': ' + error.message);
    }
  }
);

async function inspectCreativeFrames(adPage, videoMap, frameEvidence, recordPackages) {
  for (const frame of adPage.frames()) {
    const isCreativeFrame = frame !== adPage.mainFrame() && !(frame.url() || '').includes('/sadbundle/');

    try {
      const html = await frame.content();
      recordPackages(html, 'frameHtml');

      const assets = extractVideoAssets(html);
      for (const asset of assets) mergeVideoAsset(videoMap, asset);

      if (isCreativeFrame) {
        const evidence = getFrameEvidence(frameEvidence, frame);
        for (const pkg of extractExplicitStorePackages(html)) evidence.packages.add(pkg);
        for (const asset of assets) mergeVideoAsset(evidence.videos, asset);
      }
    } catch {}

    // Inspect live script text and c-wiz attributes/text explicitly. Some Google
    // renderer initialization values are encoded in these nodes and are not
    // consistently represented in visible text or clickable destination links.
    try {
      const livePayload = await frame.evaluate(() => {
        const scripts = Array.from(document.scripts || [])
          .map(script => script.textContent || '')
          .join('\n');
        const wizardPayload = Array.from(document.querySelectorAll('c-wiz'))
          .map(node => {
            const attributes = Array.from(node.attributes || [])
              .map(attribute => attribute.name + '=' + attribute.value)
              .join(' ');
            return attributes + '\n' + (node.textContent || '');
          })
          .join('\n');
        const canvas = document.querySelector('#single-ad-canvas');
        return [
          document.title || '',
          scripts,
          wizardPayload,
          canvas ? canvas.outerHTML : ''
        ].join('\n').slice(0, 5000000);
      });
      recordPackages(livePayload, 'frameHtml');
    } catch {}
  }
}

async function hasSlowAdRenderer(adPage, videoMap, sawVideoRendererSignal) {
  if (sawVideoRendererSignal || videoMap.size > 0) return true;

  const rendererPattern = /boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render(?:ing)?|single-ad-canvas|googlevideo\.com|youtube\.com/i;
  for (const frame of adPage.frames()) {
    if (rendererPattern.test(frame.url() || '')) return true;

    try {
      const hints = await frame.evaluate(() => {
        const scriptSources = Array.from(document.scripts || [])
          .map(script => script.src || '')
          .join(' ');
        const hasAppAdSlot = Boolean(document.querySelector(
          '#single-ad-canvas, [data-aavs], [data-ta-slot], video'
        ));
        return {
          title: document.title || '',
          scriptSources,
          hasAppAdSlot
        };
      });

      if (
        rendererPattern.test((hints.title || '') + ' ' + (hints.scriptSources || '')) ||
        hints.hasAppAdSlot
      ) return true;
    } catch {}
  }

  return false;
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

  let detectedBlock = null;
  let suspiciousResponseCount = 0;

  function recordResponseAssessment(assessment, responseUrl) {
    let label = String(responseUrl || 'unknown URL').slice(0, 120);
    try {
      const parsed = new URL(responseUrl);
      label = parsed.hostname + parsed.pathname.slice(0, 100);
    } catch {}

    if (assessment && assessment.blocked && !detectedBlock) {
      detectedBlock = { reason: assessment.reason || 'Google response guard stopped the scan.', url: label };
      console.error('[Broad Scanner] Stopping after a block/challenge signal from ' + label + ': ' + detectedBlock.reason);
      emitProgress(0, maxAdsToTest, '> STOP: Google returned a block/challenge signal. This scan was stopped to avoid incomplete results.');
    } else if (assessment && assessment.suspicious) {
      suspiciousResponseCount += 1;
      if (suspiciousResponseCount <= 5) {
        console.warn('[Broad Scanner] Suspicious response from ' + label + ': ' + assessment.reason);
      }
    }
    return assessment;
  }

  const getStopError = () => {
    if (detectedBlock) {
      return { code: 'ATLAS_SCAN_BLOCKED', message: detectedBlock.reason + ' Scan stopped; wait before starting another scan.' };
    }
    if (isCancelled()) return { code: 'ATLAS_SCAN_CANCELLED', message: 'Scan cancelled by user.' };
    return null;
  };

  const throwIfStopped = () => {
    const stop = getStopError();
    if (!stop) return;
    const error = new Error(stop.message);
    error.code = stop.code;
    throw error;
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
    let lastDiscoveryActivityAt = Date.now();
    let pendingDiscoveryResponses = 0;
    const activeDiscoveryRequests = new Set();
    const trackedRequestTypes = new Set(['document', 'xhr', 'fetch', 'script']);

    const trackDiscoveryRequest = request => {
      if (!trackedRequestTypes.has(request.resourceType()) || !isGoogleHost(request.url())) return;
      activeDiscoveryRequests.add(request);
      lastDiscoveryActivityAt = Date.now();
    };
    const finishDiscoveryRequest = request => {
      if (activeDiscoveryRequests.delete(request)) lastDiscoveryActivityAt = Date.now();
    };

    emitProgress(0, maxAdsToTest, '> Booting broad discovery scanner for "' + query + '"');
    searchPage.on('request', trackDiscoveryRequest);
    searchPage.on('requestfinished', finishDiscoveryRequest);
    searchPage.on('requestfailed', finishDiscoveryRequest);
    searchPage.on('response', async response => {
      const request = response.request();
      const resourceType = request.resourceType();
      if (!trackedRequestTypes.has(resourceType)) return;
      pendingDiscoveryResponses += 1;

      try {
        const url = response.url() || '';
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '').toLowerCase();
        const contentLength = Number(headers['content-length']);
        const headerAssessment = recordResponseAssessment(
          classifyGoogleResponse({ status: response.status(), contentType, resourceType, url }),
          url
        );
        if (headerAssessment.blocked) return;

        const shouldReadBody = resourceType === 'document' ||
          /text\/html|application\/xhtml\+xml/i.test(contentType) ||
          (hasClicked && ['xhr', 'fetch'].includes(resourceType));
        if (!shouldReadBody || (Number.isFinite(contentLength) && contentLength > 5000000)) return;

        const body = await response.text();
        const assessment = recordResponseAssessment(
          classifyGoogleResponse({ status: response.status(), contentType, body, resourceType, url }),
          url
        );
        if (assessment.blocked || assessment.suspicious) return;
        if (!hasClicked || !['xhr', 'fetch'].includes(resourceType)) return;
        if (url.includes('SearchAdvertisers')) return;

        if (!arId) {
          const postData = request.postData() || '';
          const match = url.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
          if (match) arId = match[1];
        }
        if (!arId) arId = body.match(/(AR[0-9]{15,})/)?.[1] || null;
        for (const match of body.matchAll(/"(CR[0-9]+)"/g)) adIds.add(match[1]);
      } catch (error) {
        console.warn('[Broad Scanner] Could not inspect discovery response: ' + error.message);
      } finally {
        pendingDiscoveryResponses = Math.max(0, pendingDiscoveryResponses - 1);
        lastDiscoveryActivityAt = Date.now();
      }
    });



    if (/^AR[0-9]{15,}$/i.test(query)) {
      arId = query.toUpperCase();
      hasClicked = true;
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, {
        waitUntil: 'domcontentloaded', timeout: 60000
      });
      await waitForStableSignal({
        inspect: async () => {},
        getSignature: () => String(arId || '') + ':' + adIds.size,
        getLastActivityAt: () => lastDiscoveryActivityAt,
        getPendingCount: () => activeDiscoveryRequests.size + pendingDiscoveryResponses,
        getStopError,
        minWaitMs: 1600,
        stableForMs: 1100,
        quietForMs: 850,
        pollIntervalMs: 250,
        normalMaxWaitMs: 6000,
        slowMaxWaitMs: 6000
      });
      throwIfStopped();
    } else {
      await searchPage.goto('https://adstransparency.google.com/?region=any', {
        waitUntil: 'domcontentloaded', timeout: 60000
      });
      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);
      try {
        await searchPage.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 6000 });
      } catch (error) {
        throwIfStopped();
        await searchPage.waitForTimeout(350);
      }
      throwIfStopped();

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
        throwIfStopped();
        await searchPage.waitForTimeout(300);
        waited += 300;
      }
      throwIfStopped();
      if (!arId) throw new Error('Failed to resolve advertiser ID.');
    }

    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to intercept ${maxAdsToTest} ads...`);
    let strikes = 0;
    let previousSize = adIds.size;
    while (adIds.size < maxAdsToTest && strikes < 3) {
      throwIfStopped();
      await searchPage.mouse.wheel(0, 3000);
      await waitForStableSignal({
        inspect: async () => {},
        getSignature: () => String(arId || '') + ':' + adIds.size,
        getLastActivityAt: () => lastDiscoveryActivityAt,
        getPendingCount: () => activeDiscoveryRequests.size + pendingDiscoveryResponses,
        getStopError,
        minWaitMs: 1400,
        stableForMs: 700,
        quietForMs: 600,
        pollIntervalMs: 150,
        normalMaxWaitMs: 3000,
        slowMaxWaitMs: 3000
      });
      throwIfStopped();
      if (adIds.size === previousSize) strikes += 1;
      else {
        strikes = 0;
        previousSize = adIds.size;
        emitProgress(0, maxAdsToTest, '> ... intercepted ' + adIds.size + ' ads so far...');
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
    let queuedVideoPersistenceTasks = 0;
    const sourceDiscoveryTotals = { requestUrl: 0, responseBody: 0, frameHtml: 0 };

    for (let i = 0; i < idArray.length; i += 1) {
      if (isCancelled()) throw new Error('Scan aborted by user.');
      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;
      const adPage = await context.newPage();
      const discovered = new Set();
      const videoMap = new Map();
      const frameEvidence = new Map();
      const packageSources = {
        requestUrl: new Set(),
        responseBody: new Set(),
        frameHtml: new Set()
      };
      let lastRelevantSignalAt = Date.now();
      let sawVideoRendererSignal = false;
      let slowRendererDetected = false;
      let pendingResponseBodies = 0;
      let lastRendererCheckAt = 0;
      const activeRelevantRequests = new Set();
      const trackedCreativeRequestTypes = new Set(['document', 'xhr', 'fetch', 'script']);

      const recordPackages = (payload, source) => {
        const candidates = extractBroadPackages(payload);
        const sourceSet = packageSources[source];
        for (const pkg of candidates) {
          sourceSet.add(pkg);
          if (!discovered.has(pkg)) {
            discovered.add(pkg);
            lastRelevantSignalAt = Date.now();
          }
        }
        return candidates.length;
      };

      const requestHandler = req => {
        const reqUrl = req.url();
        const resourceType = req.resourceType();
        let frame = null;
        try { frame = req.frame(); } catch {}
        const frameUrl = frame ? frame.url() || '' : '';

        if (/boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render|googlevideo\.com|youtube\.com/i.test(reqUrl + ' ' + frameUrl)) {
          sawVideoRendererSignal = true;
          slowRendererDetected = true;
        }
        if (trackedCreativeRequestTypes.has(resourceType)) {
          activeRelevantRequests.add(req);
          lastRelevantSignalAt = Date.now();
        }

        recordPackages(reqUrl, 'requestUrl');

        const isCreativeFrame = frame && frame !== adPage.mainFrame() && !frameUrl.includes('/sadbundle/');
        if (isCreativeFrame) {
          const evidence = getFrameEvidence(frameEvidence, frame);
          for (const pkg of extractExplicitStorePackages(reqUrl)) evidence.packages.add(pkg);
        }

        const media = parseMediaRequest(reqUrl);
        if (media) {
          sawVideoRendererSignal = true;
          slowRendererDetected = true;
          mergeVideoAsset(videoMap, media);
          if (isCreativeFrame) {
            mergeVideoAsset(getFrameEvidence(frameEvidence, frame).videos, media);
          }
        }
      };

      const responseHandler = async response => {
        const request = response.request();
        const resourceType = request.resourceType();
        if (!trackedCreativeRequestTypes.has(resourceType)) return;
        pendingResponseBodies += 1;

        try {
          const responseUrl = response.url() || '';
          if (/boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render|googlevideo\.com|youtube\.com/i.test(responseUrl)) {
            sawVideoRendererSignal = true;
            slowRendererDetected = true;
          }

          const headers = response.headers();
          const contentType = String(headers['content-type'] || '').toLowerCase();
          const headerAssessment = recordResponseAssessment(
            classifyGoogleResponse({ status: response.status(), contentType, resourceType, url: responseUrl }),
            responseUrl
          );
          if (headerAssessment.blocked) return;
          if (contentType && !/(text|json|javascript|xml|html)/i.test(contentType)) return;

          const contentLength = Number(headers['content-length']);
          if (Number.isFinite(contentLength) && contentLength > 4500000) return;

          const body = await response.text();
          if (!body || body.length > 5000000) return;
          const assessment = recordResponseAssessment(
            classifyGoogleResponse({ status: response.status(), contentType, body, resourceType, url: responseUrl }),
            responseUrl
          );
          if (assessment.blocked) return;
          if (!assessment.suspicious) recordPackages(body, 'responseBody');

          // Response payloads can discover assets, but cannot establish ownership.
          if (/googlevideo\.com|youtube\.com|youtu\.be|MediaFile|<video/i.test(body)) {
            const assets = extractVideoAssets(body);
            for (const asset of assets) mergeVideoAsset(videoMap, asset);
            if (assets.length) {
              sawVideoRendererSignal = true;
              slowRendererDetected = true;
            }
          }
        } catch (error) {
          console.warn('[Broad Scanner] Could not inspect creative response: ' + error.message);
        } finally {
          pendingResponseBodies = Math.max(0, pendingResponseBodies - 1);
          lastRelevantSignalAt = Date.now();
        }
      };

      const finishCreativeRequest = request => {
        if (activeRelevantRequests.delete(request)) lastRelevantSignalAt = Date.now();
      };



      adPage.on('request', requestHandler);
      adPage.on('requestfinished', finishCreativeRequest);
      adPage.on('requestfailed', finishCreativeRequest);
      adPage.on('response', responseHandler);
      await adPage.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) route.abort();
        else route.continue();
      });

      try {
        try {
          await adPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (error) {
          // Google can still expose useful evidence when document navigation times out.
          throwIfStopped();
          console.warn('[Broad Scanner] Creative navigation was incomplete for ' + adId + ': ' + error.message);
        }
        throwIfStopped();

        const inspectAndDetectRenderer = async () => {
          await inspectCreativeFrames(adPage, videoMap, frameEvidence, recordPackages);
          if (!slowRendererDetected && Date.now() - lastRendererCheckAt >= 800) {
            lastRendererCheckAt = Date.now();
            slowRendererDetected = await hasSlowAdRenderer(adPage, videoMap, sawVideoRendererSignal);
          }
        };

        const readiness = await waitForStableSignal({
          inspect: inspectAndDetectRenderer,
          getSignature: () => [
            [...discovered].sort().join(','),
            [...videoMap.keys()].sort().join(','),
            adPage.frames().map(frame => frame.url()).sort().join(',')
          ].join('::'),
          getLastActivityAt: () => lastRelevantSignalAt,
          getPendingCount: () => activeRelevantRequests.size + pendingResponseBodies,
          shouldExtendWait: () => slowRendererDetected || sawVideoRendererSignal || videoMap.size > 0,
          getStopError,
          minWaitMs: 1800,
          stableForMs: 1450,
          quietForMs: 1000,
          pollIntervalMs: 850,
          normalMaxWaitMs: 6500,
          slowMaxWaitMs: 15000
        });

        if (readiness.status === 'max-wait') {
          console.log('[Broad Scanner] Ad ' + (i + 1) + ' reached its bounded ' + readiness.maxWaitMs + 'ms inspection budget; preserving all evidence collected.');
        }
        throwIfStopped();



        const uniqueInAd = [...discovered];
        sourceDiscoveryTotals.requestUrl += packageSources.requestUrl.size;
        sourceDiscoveryTotals.responseBody += packageSources.responseBody.size;
        sourceDiscoveryTotals.frameHtml += packageSources.frameHtml.size;

        for (const pkg of uniqueInAd) globallyDiscovered.add(pkg);

        const attribution = buildSafeVideoAttribution(frameEvidence, videoMap);
        const videoAssets = [...videoMap.values()];
        if (videoAssets.length) {
          await videoPersistenceQueue.enqueue({
            creativeId: adId,
            advertiserId: arId,
            attribution,
            allAssets: videoAssets
          });
          queuedVideoPersistenceTasks += 1;
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
        if (error && error.code === 'ATLAS_SCAN_BLOCKED') throw error;
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}: ${error.message || 'error'}; continuing.`);
      } finally {
        adPage.off('request', requestHandler);
        adPage.off('requestfinished', finishCreativeRequest);
        adPage.off('requestfailed', finishCreativeRequest);
        adPage.off('response', responseHandler);
        await adPage.close().catch(() => {});
      }
    }

    console.log('[Broad Scanner] Package evidence source hits (overlap between sources is expected): ' +
      'request URLs=' + sourceDiscoveryTotals.requestUrl + ', response bodies=' +
      sourceDiscoveryTotals.responseBody + ', frame/DOM=' + sourceDiscoveryTotals.frameHtml + '.');

    const queueSnapshot = videoPersistenceQueue.snapshot();
    emitProgress(
      idArray.length,
      idArray.length,
      '> Finished! ' + globallyDiscovered.size + ' unique package' + (globallyDiscovered.size === 1 ? '' : 's') +
        ' discovered from ' + idArray.length + ' ads.' +
        (queuedVideoPersistenceTasks ? ' Video metadata persistence is queued separately (' + queueSnapshot.pending + ' total queued/in progress).' : '')
    );
    console.log('[Broad Scanner] Async video persistence queue: ' + JSON.stringify(queueSnapshot));
    console.log('[Broad Scanner] ' + idArray.length + ' ads -> ' + globallyDiscovered.size + ' unique packages (' + results.length + ' creative/package mappings).');
    return results;
  } catch (error) {
    console.error('Broad scanner ended:', error.message);
    emitProgress(0, maxAdsToTest, '> SCAN ENDED: ' + error.message);
    if (error && error.code === 'ATLAS_SCAN_BLOCKED') throw error;
    return [];
  } finally {
    searchPage.off('request', trackDiscoveryRequest);
    searchPage.off('requestfinished', finishDiscoveryRequest);
    searchPage.off('requestfailed', finishDiscoveryRequest);
    await browser.close().catch(() => {});
  }


}

module.exports = {
  scanCompetitor,
  extractBroadPackages,
  extractExplicitStorePackages,
  buildSafeVideoAttribution,
  isValidPackage
};
