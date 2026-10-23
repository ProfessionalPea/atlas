const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_SAFETY_MAX_ADS = Number(process.env.ATLAS_MAX_ADS_PER_SCAN) || 500;
const PLATEAU_CONSECUTIVE_ADS_LIMIT = Number(process.env.ATLAS_PLATEAU_ADS_LIMIT) || 60;
const CONCURRENT_AD_TABS = Math.max(1, Math.min(3, Number(process.env.ATLAS_AD_SCAN_CONCURRENCY) || 2));
const SCAN_DEBUG = process.env.ATLAS_SCAN_DEBUG === "1" || process.env.ATLAS_SCAN_DEBUG === "true";

const BLOCKED_PACKAGE_PREFIXES = [
  "com.google.",
  "com.android.",
  "com.facebook.",
  "com.unity3d.",
  "com.applovin.",
  "com.ironsource.",
  "com.vungle.",
  "com.adjust.",
  "com.appsflyer.",
  "com.singular.",
  "com.cloudflare.",
  "com.amazonaws.",
  "com.apple.",
  "com.microsoft.",
  "com.adobe.",
  "com.doubleclick.",
  "com.googlesyndication."
];

const CHALLENGE_PATTERN =
  /unusual traffic|our systems have detected|automated (?:queries|requests)|google\.com\/sorry|\/sorry\/index|verify (?:that )?you(?:'re| are) human|complete the security check|traffic from your computer network/i;

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== "string") return false;
  const clean = pkg.trim().toLowerCase();
  if (clean.length < 7 || clean.length > 255) return false;
  if (!clean.startsWith("com.")) return false;
  if (BLOCKED_PACKAGE_PREFIXES.some(prefix => clean.startsWith(prefix))) return false;
  if (clean.includes("_known_") || /\.(?:js|json|png|css|html?|svg|woff2?)$/i.test(clean)) return false;

  const segments = clean.split(".");
  if (segments.length < 3 || segments.length > 26) return false;
  return segments.slice(1).every(seg => /^[a-z0-9_]+$/.test(seg) && /[a-z]/.test(seg));
}

function decodeForInspection(value) {
  let decoded = String(value || "");

  for (let pass = 0; pass < 4; pass += 1) {
    const before = decoded;
    decoded = decoded
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\\u([0-9a-f]{4})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\(["'])/g, "$1")
      .replace(/\\[nrt]/g, " ");

    // Decode contiguous %XX sequences individually so a stray '%' in CSS/HTML
    // (such as "width: 100%") never aborts URI decoding for the rest of the payload.
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

function extractPackagesFromText(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const decoded = decodeForInspection(rawText.slice(0, 5_000_000));
  const matches = new Set();

  const addCandidate = (candidate) => {
    if (!candidate) return;
    const cleaned = String(candidate).replace(/\.+$/, "").trim().toLowerCase();
    if (isValidPackage(cleaned)) matches.add(cleaned);
  };

  // 1. Direct Play Store / market URL ?id=com.xxx extraction
  const urlRegex = /(?:id=|details\?[^"'\s<>]*?\bid=|market:\/\/details\?[^"'\s<>]*?\bid=)(com\.[a-zA-Z0-9_.]+)/gi;
  for (const match of decoded.matchAll(urlRegex)) {
    addCandidate(match[1]);
  }

  // 2. Structured JSON / WIZ metadata keys
  const keyedRegex = /(?:packageName|package_name|appId|app_id|bundleId|bundle_id|androidPackageName|android_package_name|applicationId|application_id|storePackageName|store_package_name)["']?\s*[:=]\s*["'](com\.[a-zA-Z0-9_.]+)["']/gi;
  for (const match of decoded.matchAll(keyedRegex)) {
    addCandidate(match[1]);
  }

  // 3. General com.publisher.game token scan (allowing digits after dots, e.g. com.funsol.3dgame)
  const tokenRegex = /\b(com(?:\.[a-zA-Z0-9_]+){2,25})\b/gi;
  for (const match of decoded.matchAll(tokenRegex)) {
    addCandidate(match[1]);
  }

  return Array.from(matches);
}

function extractCreativeIdsFromText(text, advertiserId, targetSet) {
  if (!text) return 0;
  const decoded = decodeForInspection(text);
  let added = 0;
  const crRegex = /\b(CR\d{15,22})\b/g;
  let match;
  while ((match = crRegex.exec(decoded)) !== null) {
    const crId = match[1];
    if (!targetSet.has(crId)) {
      targetSet.add(crId);
      added++;
    }
  }
  return added;
}

async function scanCompetitor(
  searchQuery,
  targetCountry = "Any",
  targetUniqueGames = 20,
  onProgress = () => {},
  onPackageFound = async () => {},
  shouldCancel = () => false
) {
  const desiredUniqueGames = Math.max(1, Number(targetUniqueGames) || 20);
  const maxAdsToInspect = Math.min(
    5000,
    Math.max(desiredUniqueGames * 6, DEFAULT_SAFETY_MAX_ADS)
  );

  console.log(`🚀 [Master Scanner] Starting unique-package pipeline for: "${searchQuery}" (Target: ${desiredUniqueGames} unique games, Safety cap: ${maxAdsToInspect} ads)`);

  let browser = null;
  let context = null;

  const discoveredCreativeIds = new Set();
  const uniquePackagesFound = new Set();
  const creativePackageResults = []; // { package, creativeId }
  let adsInspected = 0;
  let duplicateAds = 0;
  let adsWithoutPackages = 0;
  let adsSinceLastNewPackage = 0;
  let scanStopReason = null;
  let detectedChallengeReason = null;
  let debugDumpsWritten = 0;
  const startTime = Date.now();

  const reportProgress = (extra = {}) => {
    const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
    const discoveredCount = discoveredCreativeIds.size;
    let estSeconds = 0;

    if (uniquePackagesFound.size > 0 && uniquePackagesFound.size < desiredUniqueGames) {
      const secPerGame = elapsedSec / uniquePackagesFound.size;
      estSeconds = Math.max(0, Math.round((desiredUniqueGames - uniquePackagesFound.size) * secPerGame));
    } else if (adsInspected > 0) {
      const secPerAd = elapsedSec / adsInspected;
      const expectedTotalAds = Math.max(adsInspected, discoveredCount || maxAdsToInspect);
      estSeconds = Math.max(0, Math.round((expectedTotalAds - adsInspected) * secPerAd));
    } else {
      estSeconds = Math.round(Math.min(maxAdsToInspect, desiredUniqueGames * 3) / 0.4);
    }

    const mins = String(Math.floor(estSeconds / 60)).padStart(2, "0");
    const secs = String(estSeconds % 60).padStart(2, "0");

    onProgress({
      currentAd: uniquePackagesFound.size > 0 ? uniquePackagesFound.size : adsInspected,
      totalAds: uniquePackagesFound.size > 0 ? desiredUniqueGames : Math.max(1, discoveredCount || maxAdsToInspect),
      targetUniqueGames: desiredUniqueGames,
      uniqueGamesFound: uniquePackagesFound.size,
      adsInspected,
      discoveredCreatives: discoveredCount,
      duplicateAds,
      adsWithoutPackages,
      maxAdsToInspect,
      scanStopReason,
      timeRemaining: uniquePackagesFound.size >= desiredUniqueGames ? "00:00" : `${mins}:${secs}`,
      ...extra
    });
  };

  try {
    console.log("🟢 [DEBUG] 1. Launching Browser with Stealth Params...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    });

    const feedPage = await context.newPage();
    let resolvedAdvertiserId = /^AR\d{15,22}$/i.test(searchQuery.trim())
      ? searchQuery.trim().toUpperCase()
      : null;

    // Intercept RPC calls on the feed page to harvest CR IDs
    feedPage.on("response", async (response) => {
      const url = response.url();
      const status = response.status();
      if (status === 429 || url.includes("google.com/sorry")) {
        detectedChallengeReason = `Google rate-limited feed request (HTTP ${status} at ${url.slice(0, 80)})`;
        return;
      }
      if (
        !url.includes("SearchCreatives") &&
        !url.includes("LookupService") &&
        !url.includes("adstransparency") &&
        !url.includes("clients6.google.com")
      ) {
        return;
      }
      try {
        const text = await response.text();
        if (CHALLENGE_PATTERN.test(text.slice(0, 4000))) {
          detectedChallengeReason = "Google CAPTCHA / unusual traffic challenge detected on feed page.";
          return;
        }
        if (!resolvedAdvertiserId) {
          const arMatch = text.match(/\b(AR\d{15,22})\b/);
          if (arMatch) resolvedAdvertiserId = arMatch[1];
        }
        const added = extractCreativeIdsFromText(text, resolvedAdvertiserId, discoveredCreativeIds);
        if (added > 0) {
          console.log(`🔎 [CREATIVE IDS] Added ${added}; total=${discoveredCreativeIds.size}`);
          reportProgress();
        }
      } catch {}
    });

    const regionParam = (!targetCountry || targetCountry.toLowerCase() === "any")
      ? "anywhere"
      : targetCountry.toUpperCase();

    if (resolvedAdvertiserId) {
      const directUrl = `https://adstransparency.google.com/advertiser/${resolvedAdvertiserId}?region=${regionParam}`;
      console.log(`🟢 [DEBUG] 5. Direct AR ID detected (${resolvedAdvertiserId}). Navigating...`);
      reportProgress({ log: `> Opening transparency feed for ${resolvedAdvertiserId}...` });
      await feedPage.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await feedPage.waitForTimeout(3500);
    } else {
      const searchUrl = `https://adstransparency.google.com/?region=${regionParam}`;
      console.log(`🟢 [DEBUG] Searching transparency center for "${searchQuery}"...`);
      reportProgress({ log: `> Searching advertiser "${searchQuery}"...` });
      await feedPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await feedPage.waitForTimeout(2500);

      const inputSelector = 'input[type="text"], input[type="search"], material-input input, [role="textbox"]';
      await feedPage.waitForSelector(inputSelector, { timeout: 15000 });
      await feedPage.fill(inputSelector, searchQuery);
      await feedPage.waitForTimeout(2000);
      await feedPage.keyboard.press("ArrowDown");
      await feedPage.waitForTimeout(400);
      await feedPage.keyboard.press("Enter");
      await feedPage.waitForTimeout(4000);

      const currentUrl = feedPage.url();
      const urlArMatch = currentUrl.match(/\b(AR\d{15,22})\b/);
      if (urlArMatch) resolvedAdvertiserId = urlArMatch[1];
    }

    const domHarvest = async () => {
      try {
        const html = await feedPage.content();
        if (CHALLENGE_PATTERN.test(html.slice(0, 5000)) || feedPage.url().includes("google.com/sorry")) {
          detectedChallengeReason = "Google CAPTCHA / unusual traffic challenge detected.";
          return;
        }
        if (!resolvedAdvertiserId) {
          const arMatch = html.match(/\b(AR\d{15,22})\b/);
          if (arMatch) resolvedAdvertiserId = arMatch[1];
        }
        extractCreativeIdsFromText(html, resolvedAdvertiserId, discoveredCreativeIds);
      } catch {}
    };

    await domHarvest();

    if (detectedChallengeReason) {
      console.error(`🛑 [DEBUG] ${detectedChallengeReason}`);
      scanStopReason = "blocked";
      reportProgress({ log: `> 🛑 ${detectedChallengeReason}` });
      return [];
    }

    let scrollStrikes = 0;
    const MAX_SCROLL_STRIKES = 4;
    let feedExhausted = false;

    const scrollForMoreCreatives = async () => {
      if (feedExhausted || feedPage.isClosed()) return false;
      const beforeCount = discoveredCreativeIds.size;

      console.log(`🟢 [DEBUG] Scrolling feed to load more ad creatives (current total=${beforeCount})...`);
      for (let step = 0; step < 3; step++) {
        if (shouldCancel()) return false;
        await feedPage.evaluate(() => window.scrollBy(0, 2200));
        await feedPage.waitForTimeout(1400);
      }
      await domHarvest();

      const afterCount = discoveredCreativeIds.size;
      if (afterCount > beforeCount) {
        scrollStrikes = 0;
        reportProgress();
        return true;
      }

      scrollStrikes += 1;
      console.log(`🟡 [DEBUG] Scroll strike ${scrollStrikes}/${MAX_SCROLL_STRIKES}. Total creatives=${afterCount}.`);
      if (scrollStrikes >= MAX_SCROLL_STRIKES) {
        feedExhausted = true;
        return false;
      }
      return true;
    };

    while (discoveredCreativeIds.size < Math.min(40, desiredUniqueGames * 2) && !feedExhausted && !shouldCancel()) {
      await scrollForMoreCreatives();
    }

    if (!resolvedAdvertiserId) {
      console.log("⚠️ [DEBUG] Could not resolve Advertiser AR ID.");
      scanStopReason = "no_matching_advertiser";
      reportProgress({ log: `> ⚠️ Could not resolve advertiser page for "${searchQuery}".` });
      return [];
    }

    const inspectedCreativeIds = new Set();

    const inspectCreative = async (crId, indexNumber) => {
      if (shouldCancel() || scanStopReason) return;
      const adUrl = `https://adstransparency.google.com/advertiser/${resolvedAdvertiserId}/creative/${crId}?region=any`;
      console.log(`🟢 [DEBUG] 8. [Ad #${indexNumber} | Unique Games: ${uniquePackagesFound.size}/${desiredUniqueGames}] Navigating to: ${adUrl}`);

      const adPage = await context.newPage();
      const adPackages = new Set();
      const pendingResponses = new Set();
      const debugResponses = [];

      await adPage.route("**/*", (route) => {
        const reqType = route.request().resourceType();
        if (["image", "media", "font"].includes(reqType)) {
          return route.abort();
        }
        return route.continue();
      });

      const collectFromText = (txt) => {
        for (const pkg of extractPackagesFromText(txt)) {
          adPackages.add(pkg);
        }
      };

      adPage.on("request", (req) => {
        collectFromText(req.url());
      });

      adPage.on("response", (res) => {
        const rUrl = res.url();
        const status = res.status();
        const reqType = res.request().resourceType();
        collectFromText(rUrl);

        if ((status === 429 || rUrl.includes("google.com/sorry")) && !detectedChallengeReason) {
          detectedChallengeReason = `Google rate-limited creative inspection (HTTP ${status} on Ad #${indexNumber})`;
        }

        if (!["document", "xhr", "fetch", "script"].includes(reqType)) return;

        const job = (async () => {
          try {
            const headers = res.headers();
            const len = Number(headers["content-length"] || 0);
            if (Number.isFinite(len) && len > 4_500_000) return;
            const body = await res.text();
            if (!body || body.length > 5_000_000) return;

            if (CHALLENGE_PATTERN.test(body.slice(0, 4000)) && !detectedChallengeReason) {
              detectedChallengeReason = `Google CAPTCHA challenge returned on Ad #${indexNumber}`;
              return;
            }

            collectFromText(body);

            if (SCAN_DEBUG && debugResponses.length < 25) {
              debugResponses.push({
                url: rUrl.slice(0, 200),
                status,
                type: reqType,
                length: body.length,
                sample: body.slice(0, 500)
              });
            }
          } catch {}
        })().finally(() => pendingResponses.delete(job));

        pendingResponses.add(job);
      });

      const inspectFramesDom = async () => {
        try {
          const mainHtml = await adPage.content();
          collectFromText(mainHtml);
        } catch {}

        for (const frame of adPage.frames()) {
          try {
            collectFromText(frame.url());
            const frameHtml = await frame.content();
            collectFromText(frameHtml);
          } catch {}

          try {
            const livePayload = await frame.evaluate(() => {
              const scripts = Array.from(document.scripts || [])
                .map(s => s.textContent || "")
                .join("\n");
              const cwiz = Array.from(document.querySelectorAll("c-wiz"))
                .map(node => {
                  const attrs = Array.from(node.attributes || [])
                    .map(a => `${a.name}=${a.value}`)
                    .join(" ");
                  return `${attrs}\n${node.textContent || ""}`;
                })
                .join("\n");
              const links = Array.from(document.querySelectorAll("a[href]"))
                .map(a => a.getAttribute("href") || "")
                .join("\n");
              const canvas = document.querySelector("#single-ad-canvas");
              return [document.title || "", scripts, cwiz, links, canvas ? canvas.outerHTML : ""]
                .join("\n")
                .slice(0, 3_000_000);
            });
            collectFromText(livePayload);
          } catch {}
        }
      };

      try {
        await adPage.goto(adUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Wait adaptively up to ~6.5s for Google's GetCreativeById RPC and nested
        // fletch-render / sadbundle creative iframes to finish mounting.
        const checkpoints = [1200, 2400, 3800, 5200, 6500];
        const started = Date.now();
        for (const cp of checkpoints) {
          if (shouldCancel() || detectedChallengeReason) break;
          const elapsed = Date.now() - started;
          if (cp > elapsed) {
            await adPage.waitForTimeout(cp - elapsed);
          }
          if (pendingResponses.size > 0) {
            await Promise.allSettled(Array.from(pendingResponses));
          }
          await inspectFramesDom();
          if (adPackages.size > 0 && cp >= 2400) break;
        }

        if (pendingResponses.size > 0) {
          await Promise.allSettled(Array.from(pendingResponses));
        }
        await inspectFramesDom();

        if (SCAN_DEBUG && adPackages.size === 0 && debugDumpsWritten < 5) {
          debugDumpsWritten += 1;
          try {
            const debugDir = path.join(process.cwd(), "debug-scan");
            fs.mkdirSync(debugDir, { recursive: true });
            const frameSummaries = adPage.frames().map(f => ({ url: f.url() }));
            fs.writeFileSync(
              path.join(debugDir, `${crId}.json`),
              JSON.stringify(
                {
                  creativeId: crId,
                  adUrl,
                  finalPageUrl: adPage.url(),
                  detectedChallengeReason,
                  frames: frameSummaries,
                  responses: debugResponses
                },
                null,
                2
              ),
              "utf8"
            );
            await adPage.screenshot({ path: path.join(debugDir, `${crId}.png`), fullPage: true }).catch(() => {});
          } catch {}
        }
      } catch (err) {
        console.log(`🟡 [DEBUG] [Ad #${indexNumber}] Navigation timeout/warning: ${err.message}`);
      } finally {
        try { await adPage.close(); } catch {}
      }

      if (detectedChallengeReason) {
        console.error(`🛑 [DEBUG] Stopping scan: ${detectedChallengeReason}`);
        scanStopReason = "blocked";
        reportProgress({ log: `> 🛑 ${detectedChallengeReason}. Wait a few minutes before retrying.` });
        return;
      }

      adsInspected += 1;
      const foundList = Array.from(adPackages);

      if (foundList.length === 0) {
        adsWithoutPackages += 1;
        adsSinceLastNewPackage += 1;
        console.log(`🟡 [DEBUG] [Ad #${indexNumber}] No valid packages found.`);
      } else {
        let discoveredNewInThisAd = 0;
        for (const pkg of foundList) {
          creativePackageResults.push({
            package: pkg,
            creativeId: crId
          });
          if (!uniquePackagesFound.has(pkg)) {
            uniquePackagesFound.add(pkg);
            discoveredNewInThisAd += 1;
          }
          try { await onPackageFound(pkg); } catch {}
        }

        if (discoveredNewInThisAd > 0) {
          adsSinceLastNewPackage = 0;
          console.log(
            `🟢 [DEBUG] [Ad #${indexNumber}] SUCCESS: Found ${foundList.length} packages (${discoveredNewInThisAd} NEW -> ${uniquePackagesFound.size}/${desiredUniqueGames} unique):`,
            foundList
          );
        } else {
          duplicateAds += 1;
          adsSinceLastNewPackage += 1;
          console.log(
            `🔵 [DEBUG] [Ad #${indexNumber}] Found ${foundList.length} known packages (0 new -> still ${uniquePackagesFound.size}/${desiredUniqueGames} unique).`
          );
        }
      }

      if (uniquePackagesFound.size >= desiredUniqueGames) {
        scanStopReason = "TARGET_UNIQUE_GAMES_REACHED";
      } else if (adsInspected >= maxAdsToInspect) {
        scanStopReason = "SAFETY_AD_CAP_REACHED";
      } else if (adsSinceLastNewPackage >= PLATEAU_CONSECUTIVE_ADS_LIMIT && uniquePackagesFound.size > 0) {
        scanStopReason = "DIMINISHING_RETURNS_PLATEAU";
      }

      reportProgress({
        log: `> Unique games: ${uniquePackagesFound.size}/${desiredUniqueGames} (Inspected ${adsInspected}/${discoveredCreativeIds.size || maxAdsToInspect} ads)`
      });
    };

    while (!shouldCancel() && !scanStopReason) {
      const uninspected = Array.from(discoveredCreativeIds).filter(
        id => !inspectedCreativeIds.has(id)
      );

      if (uninspected.length === 0) {
        if (feedExhausted) {
          scanStopReason = "FEED_EXHAUSTED";
          break;
        }
        const foundMore = await scrollForMoreCreatives();
        if (!foundMore && Array.from(discoveredCreativeIds).every(id => inspectedCreativeIds.has(id))) {
          scanStopReason = "FEED_EXHAUSTED";
          break;
        }
        continue;
      }

      const batch = uninspected.slice(0, CONCURRENT_AD_TABS);
      for (const id of batch) inspectedCreativeIds.add(id);

      await Promise.all(
        batch.map((crId, idx) =>
          inspectCreative(crId, inspectedCreativeIds.size - batch.length + idx + 1)
        )
      );
    }

    try {
      if (!feedPage.isClosed()) await feedPage.close();
    } catch {}

    console.log(
      `🟢 [DEBUG] 9. PIPELINE COMPLETE! Stop reason: ${scanStopReason || "COMPLETE"} | Unique games found: ${uniquePackagesFound.size}/${desiredUniqueGames} | Ads inspected: ${adsInspected} | Total package hits: ${creativePackageResults.length}`
    );

    reportProgress({
      timeRemaining: "00:00",
      log: `> Discovery finished (${scanStopReason || "COMPLETE"}): ${uniquePackagesFound.size} unique games across ${adsInspected} ads.`
    });

    return creativePackageResults;
  } catch (error) {
    console.error("❌ [Master Scanner Error]:", error.message);
    throw error;
  } finally {
    console.log("🟢 [DEBUG] 10. Cleaning up & closing browser context...");
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

module.exports = {
  scanCompetitor,
  isValidPackage,
  extractPackagesFromText,
  decodeForInspection
};
