const { chromium } = require('playwright');
const { getDatabasePool } = require('./Security');
const {
  initializeIntelligenceFeatures,
  persistVideoAssets
} = require('./IntelligenceFeatures');
const { extractVideoAssets } = require('./GoogleAdsScannerV2');
const { isGoogleHost, classifyGoogleResponse, createBoundedQueue, waitForStableSignal } = require('./ScannerResilience');
const { createScanAccounting, resolveTargetUniqueGames, resolveMaxAdsToInspect } = require('./ScanAccounting');

const videoPool = getDatabasePool();
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
  // Common non-app/system identifiers and DRM key systems that appear in Google/YouTube payloads.
  'com.google.',
  'com.android.',
  'com.apple.',
  'com.youtube.',
  'com.widevine.',
  'com.microsoft.playready',
  'com.adobe.primetime',
  'com.intertrust.',
  'com.facebook.',
  'com.instagram.',
  'com.cloudflare.',
  'org.chromium.',
  'www.',
  'm.',
  'accounts.',
  'support.',
  'developers.',
  'play.',
  'store.',
  'google.',
  'youtube.',
  'facebook.',
  'instagram.',
  'schema.',
  'w3.',
  'gstatic.',
  'googleapis.',
  'googlesyndication.',
  'doubleclick.',
  'adservice.',
  'cloudflare.',
  'microsoft.',
  'apple.'
];

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const value = pkg.trim();
  if (!value || value.length > 255) return false;

  const lower = value.toLowerCase();
  if (!lower.startsWith('com.')) return false;
  if (PACKAGE_BLACKLIST.some(prefix => lower.startsWith(prefix))) return false;
  if (value.includes('_KNOWN_') || /\.(?:js|json|png|css|html?)$/i.test(lower)) return false;

  const segments = lower.split('.');
  if (segments.length < 3 || segments.length > 26) return false;
  // Allow numeric-leading segments after com.: package IDs can contain digits after a dot.
  if (!segments.slice(1).every(segment => /^[a-z0-9_]+$/.test(segment) && /[a-z]/.test(segment))) return false;

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

    decoded = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });

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

  const rendererPattern = /boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render(?:ing)?|single-ad-canvas|GetCreativeById|ads\/preview\/content\.js|googlevideo\.com|youtube\.com/i;
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
  const targetUniqueGames = resolveTargetUniqueGames(maxAdsToTest);
  const maxAdsToInspect = resolveMaxAdsToInspect();
  const accounting = createScanAccounting(targetUniqueGames, maxAdsToInspect);
  const globallyDiscovered = new Set();
  const startTime = Date.now();
  let scanStopReason = null;
  let discoveryNetworkFailure = false;
  let discoveryStopReason = null;
  const adIds = new Set();
  const results = [];

  const emitProgress = (current, total, log) => {
    let timeRemaining = 'Calculating...';
    const progressSnapshot = accounting.getSnapshot();
    const discoveredCreatives = adIds.size;
    if (progressSnapshot.uniqueGamesFound > 0 && progressSnapshot.uniqueGamesFound < targetUniqueGames) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const secondsPerUniqueGame = elapsedSeconds / progressSnapshot.uniqueGamesFound;
      const remainingSeconds = Math.max(0, Math.round(
        (targetUniqueGames - progressSnapshot.uniqueGamesFound) * secondsPerUniqueGame
      ));
      const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
      const secs = (remainingSeconds % 60).toString().padStart(2, '0');
      timeRemaining = `${mins}:${secs}`;
    } else if (progressSnapshot.uniqueGamesFound >= targetUniqueGames) {
      timeRemaining = '00:00';
    } else if (progressSnapshot.adsInspected > 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const secondsPerAd = elapsedSeconds / progressSnapshot.adsInspected;
      const expectedTotalAds = Math.max(progressSnapshot.adsInspected, discoveredCreatives || total || maxAdsToInspect);
      const remainingSeconds = Math.max(0, Math.round((expectedTotalAds - progressSnapshot.adsInspected) * secondsPerAd));
      const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
      const secs = (remainingSeconds % 60).toString().padStart(2, '0');
      timeRemaining = `${mins}:${secs}`;
    }
    onProgress({
      ...progressSnapshot,
      discoveredCreatives,
      currentAd: current,
      totalAds: total,
      timeRemaining,
      log,
      scanStopReason
    });
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
      emitProgress(0, maxAdsToInspect, '> STOP: Google returned a block/challenge signal. This scan was stopped to avoid incomplete results.');
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

  const proxyServer = process.env.ATLAS_SCANNER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--no-zygote',
      '--disable-site-isolation-trials'
    ]
  };
  if (proxyServer) {
    try {
      const parsedProxy = new URL(proxyServer.includes('://') ? proxyServer : `http://${proxyServer}`);
      launchOptions.proxy = {
        server: `${parsedProxy.protocol}//${parsedProxy.host}`
      };
      if (parsedProxy.username) {
        launchOptions.proxy.username = decodeURIComponent(parsedProxy.username);
        launchOptions.proxy.password = decodeURIComponent(parsedProxy.password || '');
      }
      console.log(`[Broad Scanner] Routing scanner traffic via proxy: ${launchOptions.proxy.server}`);
    } catch {
      launchOptions.proxy = { server: proxyServer };
      console.log(`[Broad Scanner] Routing scanner traffic via proxy: ${proxyServer}`);
    }
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'accept-language': 'en-US,en;q=0.9'
    }
  });
  const searchPage = await context.newPage();
  await searchPage.route('**/*', route => {
    const type = route.request().resourceType();
    // Only abort images, media, and fonts; let stylesheets load so Google's web components render properly
    if (['image', 'media', 'font'].includes(type)) route.abort();
    else route.continue();
  });

  let lastDiscoveryActivityAt = Date.now();
  let pendingDiscoveryResponses = 0;
  const activeDiscoveryRequests = new Set();
  const trackedRequestTypes = new Set(['document', 'xhr', 'fetch', 'script']);

  const trackDiscoveryRequest = request => {
    if (!trackedRequestTypes.has(request.resourceType()) || !isGoogleHost(request.url())) return;
    activeDiscoveryRequests.add(request);
    lastDiscoveryActivityAt = Date.now();
  };
  const finishDiscoveryRequest = (request, failed = false) => {
    if (activeDiscoveryRequests.delete(request)) lastDiscoveryActivityAt = Date.now();
    if (failed) {
      const failure = request.failure();
      const failureText = typeof failure === 'string' ? failure : String(failure?.errorText || '');
      if (/net::ERR_/i.test(failureText) && !/ERR_ABORTED/i.test(failureText)) {
        discoveryNetworkFailure = true;
      }
    }
  };
  const handleFailedDiscoveryRequest = request => finishDiscoveryRequest(request, true);

  try {
    searchPage.setDefaultTimeout(120000);
    searchPage.setDefaultNavigationTimeout(120000);

    let arId = null;
    let hasClicked = false;
    const previewUrlsByCreative = new Map();
    const seenCreativeIds = new Set();

    const extractPreviewUrlsFromJsonText = (rawText, targetCreativeId = null) => {
      if (!rawText || !rawText.includes('ads/preview/content.js')) return;
      const decoded = decodeForInspection(rawText);
      // Pair each CR... id with nearby content.js URLs, and also collect any standalone content.js URLs for targetCreativeId
      const urlRegex = /https:\/\/displayads-formats\.googleusercontent\.com\/ads\/preview\/content\.js\?[^"'\s<>\\]+/g;
      if (targetCreativeId) {
        for (const match of decoded.matchAll(urlRegex)) {
          if (!previewUrlsByCreative.has(targetCreativeId)) previewUrlsByCreative.set(targetCreativeId, new Set());
          previewUrlsByCreative.get(targetCreativeId).add(match[0]);
        }
      }
      const itemRegex = /"(CR[0-9]{10,})"[\s\S]{0,600}?(https:\/\/displayads-formats\.googleusercontent\.com\/ads\/preview\/content\.js\?[^"'\s<>\\]+)/g;
      for (const match of decoded.matchAll(itemRegex)) {
        const crId = match[1];
        const previewUrl = match[2];
        if (!previewUrlsByCreative.has(crId)) previewUrlsByCreative.set(crId, new Set());
        previewUrlsByCreative.get(crId).add(previewUrl);
      }
    };

    const prioritizeUnseenCreatives = ids => {
      const unseen = [];
      const seen = [];
      for (const id of ids) {
        if (seenCreativeIds.has(id)) seen.push(id);
        else unseen.push(id);
      }
      return [...unseen, ...seen];
    };

    emitProgress(0, maxAdsToInspect, '> Booting scanner for "' + query + '". Target: ' + targetUniqueGames + ' unique games; safety cap: ' + maxAdsToInspect + ' inspected ads.');
    searchPage.on('request', trackDiscoveryRequest);
    searchPage.on('requestfinished', finishDiscoveryRequest);
    searchPage.on('requestfailed', handleFailedDiscoveryRequest);
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

        const status = response.status();
        if (status >= 300 && status < 400) return;

        const shouldReadBody = resourceType === 'document' ||
          /text\/html|application\/xhtml\+xml/i.test(contentType) ||
          (hasClicked && ['xhr', 'fetch'].includes(resourceType));
        if (!shouldReadBody || (Number.isFinite(contentLength) && contentLength > 5000000)) return;

        const body = await response.text();
        const assessment = recordResponseAssessment(
          classifyGoogleResponse({ status, contentType, body, resourceType, url }),
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
        extractPreviewUrlsFromJsonText(body);
      } catch (error) {
        const msg = String(error?.message || '');
        if (!/No data found for resource|navigated away|redirect responses|Target closed|closed/i.test(msg)) {
          console.warn('[Broad Scanner] Could not inspect discovery response: ' + msg);
        }
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
      await waitForStableSignal({
        inspect: async () => {},
        getSignature: () => 'advertiser-search-home',
        getLastActivityAt: () => lastDiscoveryActivityAt,
        getPendingCount: () => activeDiscoveryRequests.size + pendingDiscoveryResponses,
        getStopError,
        minWaitMs: 400,
        stableForMs: 350,
        quietForMs: 300,
        pollIntervalMs: 150,
        normalMaxWaitMs: 2500,
        slowMaxWaitMs: 2500
      });
      throwIfStopped();

      const searchBox = searchPage.getByRole('textbox').first();
      try {
        await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      } catch (error) {
        throwIfStopped();
        throw error;
      }
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
        scanStopReason = 'no_matching_advertiser';
        emitProgress(0, maxAdsToInspect, `> No registered advertiser matching "${query}" was found.`);
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

    const initialBatchSize = Math.min(10, maxAdsToInspect);
    let strikes = 0;

    const collectMoreAds = async () => {
      throwIfStopped();
      const sizeBefore = adIds.size;
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

      if (adIds.size === sizeBefore) {
        strikes += 1;
      } else {
        strikes = 0;
      }

      if (adIds.size >= maxAdsToInspect) discoveryStopReason = 'safety_limit';
      else if (strikes >= 3) {
        discoveryStopReason = discoveryNetworkFailure ? 'discovery_error' : 'ads_exhausted';
      } else {
        discoveryStopReason = null;
      }

      return adIds.size > sizeBefore;
    };

    emitProgress(0, maxAdsToInspect, '> Loading an initial batch of ad creatives. Target: ' + targetUniqueGames + ' unique games; safety cap: ' + maxAdsToInspect + ' inspected ads.');
    while (adIds.size < initialBatchSize && strikes < 3) {
      const addedAds = await collectMoreAds();
      if (addedAds) {
        emitProgress(0, maxAdsToInspect, '> Intercepted ' + adIds.size + ' ad creatives; preparing to inspect them.');
      }
    }

    if (adIds.size >= maxAdsToInspect) discoveryStopReason = 'safety_limit';
    else if (strikes >= 3 && !discoveryStopReason) {
      discoveryStopReason = discoveryNetworkFailure ? 'discovery_error' : 'ads_exhausted';
    }

    try {
      const { rows: seenRows } = await videoPool.query(
        `SELECT ac.creative_id
         FROM ad_creatives ac
         LEFT JOIN competitors c ON c.id = ac.competitor_id
         WHERE ac.creative_id LIKE 'CR%'
           AND ($1::text IS NULL OR c.ads_id = $1 OR ac.creative_id = ANY($2::text[]))`,
        [arId || null, [...adIds]]
      );
      for (const row of seenRows) {
        if (row.creative_id) seenCreativeIds.add(row.creative_id);
      }
    } catch {}

    const inspectedCreativeIds = new Set();
    let idArray = prioritizeUnseenCreatives([...adIds]).slice(0, maxAdsToInspect);
    if (!idArray.length) {
      scanStopReason = discoveryStopReason === 'discovery_error' ? 'discovery_error' : 'ads_exhausted';
      const emptyMessage = scanStopReason === 'discovery_error'
        ? '> Discovery ended with network errors before any ad creatives could be collected; results may be incomplete.'
        : '> No ad creatives were available for this advertiser.';
      await searchPage.close().catch(() => {});
      emitProgress(0, maxAdsToInspect, emptyMessage);
      return [];
    }

    // If all initial creatives were already seen in previous scans, scroll a couple more times up front to surface fresh creatives.
    while (
      idArray.every(id => seenCreativeIds.has(id)) &&
      adIds.size < Math.min(120, maxAdsToInspect) &&
      !discoveryStopReason &&
      strikes < 3
    ) {
      const added = await collectMoreAds();
      if (!added) break;
      idArray = prioritizeUnseenCreatives([...adIds]).slice(0, maxAdsToInspect);
    }

    emitProgress(0, maxAdsToInspect, '> Intercepted an initial batch of ' + idArray.length + ' ads. Continuing discovery only if more unique games are needed.');

    results.length = 0;
    let queuedVideoPersistenceTasks = 0;
    const sourceDiscoveryTotals = { requestUrl: 0, responseBody: 0, frameHtml: 0 };

    for (let i = 0; i < maxAdsToInspect; i += 1) {
      while (i >= idArray.length && !discoveryStopReason && !accounting.hasReachedTarget()) {
        const previousSize = adIds.size;
        let addedAds = false;
        try {
          addedAds = await collectMoreAds();
        } catch (scrollError) {
          if (scrollError && scrollError.code === 'ATLAS_SCAN_BLOCKED' && results.length > 0) {
            scanStopReason = 'rate_limited';
            console.warn(
              `⚠️ [Broad Scanner] Rate limited during feed scroll after finding ${results.length} package mappings (${accounting.getSnapshot().uniqueGamesFound} games). Preserving results.`
            );
            break;
          }
          throw scrollError;
        }
        if (scanStopReason) break;
        if (addedAds || adIds.size > previousSize) {
          const remaining = prioritizeUnseenCreatives(
            [...adIds].filter(id => !inspectedCreativeIds.has(id))
          );
          idArray = [...inspectedCreativeIds, ...remaining].slice(0, maxAdsToInspect);
          emitProgress( accounting.getSnapshot().adsInspected, maxAdsToInspect,
            '> Intercepted ' + idArray.length + ' ad creatives so far; ' +
            accounting.getSnapshot().uniqueGamesFound + '/' + targetUniqueGames + ' unique games found.'
          );
        }
      }
      if (scanStopReason) break;
      if (i >= idArray.length || accounting.hasReachedTarget()) break;
      if (isCancelled()) {
        // User abort: stop inspecting but keep (and return) everything collected so far.
        scanStopReason = 'cancelled';
        break;
      }
      const adId = idArray[i];
      inspectedCreativeIds.add(adId);
      accounting.markInspected();
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

      const isBackgroundTelemetryUrl = urlStr =>
        /youtube\.com\/(?:s\/player|youtubei|ptracking|api\/stats)|play\.google\.com\/log|feedback-pa\.clients6\.google\.com|google\.com\/js\/th\/|doubleclick\.net\/pagead\/id/i.test(urlStr);

      const requestHandler = req => {
        const reqUrl = req.url();
        const resourceType = req.resourceType();
        let frame = null;
        try { frame = req.frame(); } catch {}
        const frameUrl = frame ? frame.url() || '' : '';

        if (/boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render|GetCreativeById|ads\/preview\/content\.js|googlevideo\.com|youtube\.com/i.test(reqUrl + ' ' + frameUrl)) {
          sawVideoRendererSignal = true;
          slowRendererDetected = true;
        }
        if (trackedCreativeRequestTypes.has(resourceType) && !isBackgroundTelemetryUrl(reqUrl)) {
          activeRelevantRequests.add(req);
          lastRelevantSignalAt = Date.now();
        }

        recordPackages(reqUrl, 'requestUrl');

        const isCreativeFrame = frame && frame !== adPage.mainFrame() && !frameUrl.includes('/sadbundle/');
        if (isCreativeFrame) {
          const evidence = getFrameEvidence(frameEvidence, frame);
          for (const pkg of extractExplicitStorePackages(reqUrl)) evidence.packages.add(pkg);
        }

        if (/youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/watch/i.test(reqUrl)) {
          const urlAssets = extractVideoAssets(reqUrl);
          for (const asset of urlAssets) {
            sawVideoRendererSignal = true;
            slowRendererDetected = true;
            mergeVideoAsset(videoMap, asset);
            if (isCreativeFrame) {
              mergeVideoAsset(getFrameEvidence(frameEvidence, frame).videos, asset);
            }
          }
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
        const responseUrl = response.url() || '';
        if (!trackedCreativeRequestTypes.has(resourceType) || isBackgroundTelemetryUrl(responseUrl)) return;
        pendingResponseBodies += 1;

        try {
          if (/boq-ads-ui|SearchAdsViewerRenderingUi|single-ad-render|GetCreativeById|ads\/preview\/content\.js|googlevideo\.com|youtube\.com/i.test(responseUrl)) {
            sawVideoRendererSignal = true;
            slowRendererDetected = true;
          }

          const status = response.status();
          const headers = response.headers();
          if (headers['location']) {
            recordPackages(headers['location'], 'requestUrl');
          }
          if (status >= 300 && status < 400) return;

          const contentType = String(headers['content-type'] || '').toLowerCase();
          const headerAssessment = recordResponseAssessment(
            classifyGoogleResponse({ status, contentType, resourceType, url: responseUrl }),
            responseUrl
          );
          if (headerAssessment.blocked) return;
          if (contentType && !/(text|json|javascript|xml|html)/i.test(contentType)) return;

          const contentLength = Number(headers['content-length']);
          if (Number.isFinite(contentLength) && contentLength > 4500000) return;

          const body = await response.text();
          if (!body || body.length > 5000000) return;
          const assessment = recordResponseAssessment(
            classifyGoogleResponse({ status, contentType, body, resourceType, url: responseUrl }),
            responseUrl
          );
          if (assessment.blocked) return;
          if (responseUrl.includes('GetCreativeById') || responseUrl.includes('SearchCreatives')) {
            extractPreviewUrlsFromJsonText(body, responseUrl.includes('GetCreativeById') ? adId : null);
          }
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
          const msg = String(error?.message || '');
          if (!/No data found for resource|navigated away|redirect responses|Target closed/i.test(msg)) {
            console.warn('[Broad Scanner] Could not inspect creative response: ' + msg);
          }
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
        const reqUrl = route.request().url();
        const type = route.request().resourceType();
        if (
          ['image', 'media', 'font', 'stylesheet'].includes(type) ||
          isBackgroundTelemetryUrl(reqUrl)
        ) {
          route.abort();
        } else {
          route.continue();
        }
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

        if (discovered.size === 0 && previewUrlsByCreative.has(adId)) {
          for (const previewUrl of previewUrlsByCreative.get(adId)) {
            try {
              const previewRes = await fetch(previewUrl, { signal: AbortSignal.timeout(4500) });
              if (previewRes.ok) {
                const previewBody = await previewRes.text();
                recordPackages(previewBody, 'responseBody');
                if (/googlevideo\.com|youtube\.com|youtu\.be|MediaFile|<video/i.test(previewBody)) {
                  for (const asset of extractVideoAssets(previewBody)) mergeVideoAsset(videoMap, asset);
                }
              }
            } catch {}
          }
        }



        const uniqueInAd = [...discovered];
        const packageAccounting = accounting.recordPackages(uniqueInAd);
        sourceDiscoveryTotals.requestUrl += packageSources.requestUrl.size;
        sourceDiscoveryTotals.responseBody += packageSources.responseBody.size;
        sourceDiscoveryTotals.frameHtml += packageSources.frameHtml.size;

        for (const pkg of uniqueInAd) globallyDiscovered.add(String(pkg).trim().toLowerCase());

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
          console.log(
            `🟢 [Broad Scanner] [Ad #${i + 1} | Unique Games: ${accounting.getSnapshot().uniqueGamesFound}/${targetUniqueGames}] Discovered ${uniqueInAd.length} package(s): ${uniqueInAd.slice(0, 5).join(', ')}`
          );
          emitProgress(
            accounting.getSnapshot().adsInspected,
            maxAdsToInspect,
            `> Ad ${i + 1}: discovered ${uniqueInAd.length} valid package${uniqueInAd.length === 1 ? '' : 's'}; ` +
            accounting.getSnapshot().uniqueGamesFound + '/' + targetUniqueGames + ' unique games found' +
            (packageAccounting.isDuplicateAd ? ' (duplicate creative)' : '') +
            (videoAssets.length ? ` · ${videoAssets.length} video${videoAssets.length === 1 ? '' : 's'}` : '')
          );
        } else {
          console.log(
            `🟡 [Broad Scanner] [Ad #${i + 1} | Unique Games: ${accounting.getSnapshot().uniqueGamesFound}/${targetUniqueGames}] No valid package found.`
          );
          emitProgress(
            accounting.getSnapshot().adsInspected,
            maxAdsToInspect,
            `> Ad ${i + 1}: no valid package found.`
          );
        }
      } catch (error) {
        if (error && error.code === 'ATLAS_SCAN_CANCELLED') {
          scanStopReason = 'cancelled';
          console.warn(`🛑 [Broad Scanner] Aborted by user. Preserving ${results.length} package mappings (${accounting.getSnapshot().uniqueGamesFound} unique games) found so far.`);
          break;
        }
        if (error && error.code === 'ATLAS_SCAN_BLOCKED') {
          if (results.length > 0) {
            scanStopReason = 'rate_limited';
            console.warn(
              `⚠️ [Broad Scanner] Rate limited by Google after inspecting ${accounting.getSnapshot().adsInspected} ads. Gracefully preserving ${results.length} package mappings (${accounting.getSnapshot().uniqueGamesFound} unique games) found so far.`
            );
            emitProgress(
              accounting.getSnapshot().adsInspected,
              maxAdsToInspect,
              `> Scan paused by Google rate limit. Preserving all ${accounting.getSnapshot().uniqueGamesFound} games discovered.`
            );
            break;
          }
          throw error;
        }
        emitProgress(
          accounting.getSnapshot().adsInspected,
          maxAdsToInspect,
          `> Ad ${i + 1}: ${error.message || 'error'}; continuing.`
        );
      } finally {
        adPage.off('request', requestHandler);
        adPage.off('requestfinished', finishCreativeRequest);
        adPage.off('requestfailed', finishCreativeRequest);
        adPage.off('response', responseHandler);
        await adPage.close().catch(() => {});
      }

      if (scanStopReason) break;
      if (accounting.hasReachedTarget()) {
        scanStopReason = 'target_reached';
        break;
      }

      // Natural pacing / jitter between inspecting consecutive ad creatives to avoid burst rate-limiting
      if (i + 1 < idArray.length && !isCancelled()) {
        const jitter = Math.floor(Math.random() * 450) + 350; // 350ms - 800ms
        await new Promise(resolve => setTimeout(resolve, jitter));
      }
    }

    await searchPage.close().catch(() => {});

    if (!scanStopReason) {
      if (accounting.hasReachedTarget()) scanStopReason = 'target_reached';
      else if (discoveryNetworkFailure || discoveryStopReason === 'discovery_error') scanStopReason = 'discovery_error';
      else if (discoveryStopReason === 'safety_limit' || accounting.getSnapshot().adsInspected >= maxAdsToInspect) scanStopReason = 'safety_limit';
      else scanStopReason = 'ads_exhausted';
    }

    console.log('[Broad Scanner] Package evidence source hits (overlap between sources is expected): ' +
      'request URLs=' + sourceDiscoveryTotals.requestUrl + ', response bodies=' +
      sourceDiscoveryTotals.responseBody + ', frame/DOM=' + sourceDiscoveryTotals.frameHtml + '.');

    const queueSnapshot = videoPersistenceQueue.snapshot();
    const snapshot = accounting.getSnapshot();
    let completionMessage;
    if (scanStopReason === 'target_reached') {
      completionMessage = '> Target reached: found ' + snapshot.uniqueGamesFound + ' unique games after inspecting ' + snapshot.adsInspected + ' ads.';
    } else if (scanStopReason === 'rate_limited') {
      completionMessage = '> Scan stopped early due to Google rate limit after inspecting ' + snapshot.adsInspected + ' ads. Successfully preserved ' + snapshot.uniqueGamesFound + ' unique games found so far.';
    } else if (scanStopReason === 'safety_limit') {
      completionMessage = '> Safety cap reached after inspecting ' + snapshot.adsInspected + ' ads; found ' + snapshot.uniqueGamesFound + '/' + targetUniqueGames + ' unique games. Results may be incomplete.';
    } else if (scanStopReason === 'discovery_error') {
      completionMessage = '> Discovery encountered network errors. Found ' + snapshot.uniqueGamesFound + '/' + targetUniqueGames + ' unique games after inspecting ' + snapshot.adsInspected + ' ads; results may be incomplete.';
    } else if (scanStopReason === 'cancelled') {
      completionMessage = '> Scan cancelled after inspecting ' + snapshot.adsInspected + ' ads.';
    } else {
      completionMessage = '> Advertiser feed exhausted after inspecting ' + snapshot.adsInspected + ' ads; found ' + snapshot.uniqueGamesFound + '/' + targetUniqueGames + ' unique games.';
    }
    emitProgress(
      snapshot.adsInspected,
      maxAdsToInspect,
      completionMessage + (queuedVideoPersistenceTasks ? ' Video metadata persistence is queued separately (' + queueSnapshot.pending + ' total queued/in progress).' : '')
    );
    console.log('[Broad Scanner] Async video persistence queue: ' + JSON.stringify(queueSnapshot));
    console.log('[Broad Scanner] ' + snapshot.adsInspected + ' ads inspected -> ' + snapshot.uniqueGamesFound + ' unique packages (' + results.length + ' creative/package mappings), stop reason: ' + scanStopReason + '.');
    return results;
  } catch (error) {
    console.error('Broad scanner ended:', error.message);
    if (error && error.code === 'ATLAS_SCAN_BLOCKED') scanStopReason = 'blocked';
    else if ((error && error.code === 'ATLAS_SCAN_CANCELLED') || isCancelled()) scanStopReason = 'cancelled';
    else scanStopReason = 'scan_error';
    emitProgress(
      accounting.getSnapshot().adsInspected,
      maxAdsToInspect,
      '> Scan ended (' + scanStopReason + '): ' + error.message
    );
    if (error && error.code === 'ATLAS_SCAN_BLOCKED') {
      if (results && results.length > 0) {
        console.warn(`[Broad Scanner] ATLAS_SCAN_BLOCKED caught at top level, but ${results.length} results were preserved. Returning them.`);
        return results;
      }
      throw error;
    }
    return results && results.length > 0 ? results : [];
  } finally {
    try {
      searchPage.off('request', trackDiscoveryRequest);
      searchPage.off('requestfinished', finishDiscoveryRequest);
      searchPage.off('requestfailed', handleFailedDiscoveryRequest);
    } catch {}
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
