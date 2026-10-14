const { chromium } = require('playwright');

function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const lower = pkg.toLowerCase();

  const validPrefixes = ['com.', 'io.', 'net.', 'org.', 'games.', 'app.', 'me.', 'co.'];
  if (!validPrefixes.some(prefix => lower.startsWith(prefix))) return false;

  const blacklist = [
    'goog.', 'com.google.', 'com.android.', 'com.apple.',
    'org.w3c.', 'org.apache.', 'io.github.', 'net.gstatic.',
    'com.doubleclick.', 'com.youtube.', 'org.chromium.'
  ];
  if (blacklist.some(bad => lower.startsWith(bad))) return false;

  if (
    pkg.includes('_KNOWN_') ||
    lower.endsWith('.js') ||
    lower.endsWith('.json') ||
    lower.endsWith('.png') ||
    lower.endsWith('.css') ||
    lower.endsWith('.html')
  ) {
    return false;
  }

  const segments = pkg.split('.');
  if (segments.length < 3) return false;

  return true;
}

function extractPackagesFromText(text) {
  const found = [];
  if (!text || typeof text !== 'string') return found;

  // 1. Direct Play Store / Market URLs (standard & URL-encoded)
  const storeUrlRegex = /(?:play\.google\.com\/store\/apps\/details\?(?:[^"'\s<>]*&)?id=|market:\/\/details\?id=|details\?id=|details%3Fid%3D|id%3D)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})/gi;
  for (const m of text.matchAll(storeUrlRegex)) {
    if (isValidPackage(m[1])) found.push(m[1]);
  }

  // 2. Explicit App ID fields inside ad JSON payloads
  const jsonKeyRegex = /(?:packageName|package_name|appId|app_id|bundleId|android_package_name)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})["']/gi;
  for (const m of text.matchAll(jsonKeyRegex)) {
    if (isValidPackage(m[1])) found.push(m[1]);
  }

  return found;
}

// Helper to prevent any single promise from hanging the scanner forever
function withTimeout(promise, ms, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
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

  console.log("🟢 [DEBUG] 1. Launching Browser with Stealth Params...");
  const browser = await chromium.launch({
    headless: true, // Set to false if you want to watch the browser window visually
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const searchPage = await context.newPage();

  try {
    searchPage.setDefaultTimeout(45000);
    searchPage.setDefaultNavigationTimeout(45000);

    let arId = null;
    const adIds = new Set();
    let hasClicked = false;

    emitProgress(0, maxAdsToTest, `> 🚀 Booting scanner for: "${query}"`);

    searchPage.on('response', async (res) => {
      try {
        const url = res.url();
        if (url.includes('SearchAdvertisers')) return;

        if (hasClicked && (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch')) {
          if (!arId) {
            const postData = res.request().postData() || '';
            const match = url.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
            if (match) arId = match[1];
          }

          const text = await withTimeout(res.text(), 3000, '');
          if (!arId && text) {
            const textMatch = text.match(/(AR[0-9]{15,})/);
            if (textMatch) arId = textMatch[1];
          }

          if (text) {
            const crMatches = [...text.matchAll(/"(CR[0-9]{15,})"/g)];
            crMatches.forEach(m => adIds.add(m[1]));
          }
        }
      } catch {}
    });

    const isDirectId = /^AR[0-9]{15,}$/i.test(query);

    if (isDirectId) {
      arId = query.toUpperCase();
      hasClicked = true;
      console.log(`🟢 [DEBUG] 5. Direct AR ID detected (${arId}). Navigating...`);
      emitProgress(0, maxAdsToTest, `> ✅ Direct ID: ${arId}. Loading advertiser feed...`);

      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, {
        waitUntil: 'networkidle',
        timeout: 45000
      }).catch(() => {});
      await searchPage.waitForTimeout(3000);
    } else {
      console.log(`🟢 [DEBUG] 5. Searching Google Ads Transparency for "${query}"...`);
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);

      await searchPage.goto('https://adstransparency.google.com/?region=any', {
        waitUntil: 'networkidle',
        timeout: 45000
      }).catch(() => {});

      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);
      await searchPage.waitForTimeout(2500);

      const options = await searchPage.locator('[role="option"]').all();
      let matchedOption = null;

      for (const opt of options) {
        const text = (await opt.innerText()).trim();
        const firstLine = text.split('\n')[0].trim().toLowerCase();
        if (/\.(com|net|org|io|co|dojo|app|site|dev)/i.test(firstLine)) continue;
        if (firstLine.includes(query.toLowerCase())) {
          matchedOption = opt;
          break;
        }
      }

      if (!matchedOption) {
        console.log(`🛑 [SCAN ABORT] No advertiser matching "${query}" found.`);
        emitProgress(0, maxAdsToTest, `> ❌ No registered advertiser matching "${query}" found.`);
        await searchPage.close().catch(() => {});
        return [];
      }

      hasClicked = true;
      await matchedOption.click();
      emitProgress(0, maxAdsToTest, `> 🖱️ Selected advertiser. Resolving AR ID...`);

      let timeWaited = 0;
      while (!arId && timeWaited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(1000);
        timeWaited += 1000;
      }

      if (!arId) {
        emitProgress(0, maxAdsToTest, `> ❌ Could not resolve advertiser ID.`);
        await searchPage.close().catch(() => {});
        return [];
      }
      await searchPage.waitForTimeout(3000);
    }

    console.log("🟢 [DEBUG] 6. Scrolling to load ad creatives...");
    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to collect up to ${maxAdsToTest} ads...`);

    let strikes = 0;
    let previousSize = 0;

    while (adIds.size < maxAdsToTest && strikes < 3) {
      if (isCancelled()) break;

      await searchPage.evaluate(() => {
        window.scrollBy(0, 2500);
        const cards = document.querySelectorAll('creative-preview, [role="article"]');
        if (cards.length > 0) {
          cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      }).catch(() => {});

      await searchPage.mouse.wheel(0, 3000).catch(() => {});
      await searchPage.waitForTimeout(3500);

      if (adIds.size === previousSize) {
        strikes++;
        console.log(`🟡 [DEBUG] Scroll strike ${strikes}/3. Ad count at ${adIds.size}.`);
      } else {
        strikes = 0;
        previousSize = adIds.size;
        console.log(`🟢 [DEBUG] Intercepted ${adIds.size} ads so far...`);
        emitProgress(0, maxAdsToTest, `> ... intercepted ${adIds.size} ads so far...`);
      }
    }

    await searchPage.close().catch(() => {});
    console.log(`🟢 [DEBUG] Closed search page to free RAM.`);

    const idArray = Array.from(adIds).slice(0, maxAdsToTest);
    if (idArray.length === 0) {
      emitProgress(0, 0, `> ℹ️ No active ads found for this target.`);
      return [];
    }

    console.log(`🟢 [DEBUG] 7. Extracting packages from ${idArray.length} ads...`);
    emitProgress(0, idArray.length, `> ✅ Found ${idArray.length} ads! Inspecting creatives...`);

    const allFoundPackagesArray = [];

    for (let i = 0; i < idArray.length; i++) {
      if (isCancelled()) {
        emitProgress(i + 1, idArray.length, '> 🛑 Scan cancelled by user.');
        break;
      }

      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;
      const adPage = await context.newPage();
      const adFoundPackages = [];

      // 1. Sniff all network requests (URLs)
      adPage.on('request', (req) => {
        const pkgs = extractPackagesFromText(req.url());
        if (pkgs.length > 0) adFoundPackages.push(...pkgs);
      });

      // 2. Sniff network responses (RPC payloads & iframe HTML/scripts)
      adPage.on('response', async (res) => {
        try {
          const reqType = res.request().resourceType();
          if (['xhr', 'fetch', 'document', 'script'].includes(reqType)) {
            const body = await withTimeout(res.text(), 2000, '');
            if (body) {
              const pkgs = extractPackagesFromText(body);
              if (pkgs.length > 0) adFoundPackages.push(...pkgs);
            }
          }
        } catch {}
      });

      try {
        console.log(`\n🟢 [DEBUG] 8. [Ad ${i + 1}/${idArray.length}] Navigating to: ${url}`);

        // Wait for 'load' so the Angular shell and scripts actually initialize
        await withTimeout(
          adPage.goto(url, { waitUntil: 'load', timeout: 25000 }),
          26000
        );

        // Wait for the Google ad preview iframe to attach to the DOM
        await withTimeout(
          adPage.waitForSelector('iframe', { state: 'attached', timeout: 8000 }),
          8500
        );

        // Give the nested DoubleClick iframe 5 full seconds to render its creative
        await adPage.waitForTimeout(5000);

        const inspectFrames = async () => {
          const frames = adPage.frames();
          for (const frame of frames) {
            // Grab frame URL itself
            const urlPkgs = extractPackagesFromText(frame.url());
            if (urlPkgs.length > 0) adFoundPackages.push(...urlPkgs);

            // Grab frame DOM snapshot with a strict 1.5s timeout so it NEVER hangs
            const html = await withTimeout(
              frame.evaluate(() => document.documentElement ? document.documentElement.innerHTML : '').catch(() => ''),
              1500,
              ''
            );
            if (html) {
              const htmlPkgs = extractPackagesFromText(html);
              if (htmlPkgs.length > 0) adFoundPackages.push(...htmlPkgs);
            }
          }
        };

        await inspectFrames();

        // If nothing found after 5s, wait 3 more seconds for slow video/playable ads and re-check
        if (adFoundPackages.length === 0) {
          await adPage.waitForTimeout(3000);
          await inspectFrames();
        }

        const uniqueInAd = [...new Set(adFoundPackages)];

        if (uniqueInAd.length > 0) {
          console.log(`🟢 [DEBUG] [Ad ${i + 1}] SUCCESS: Found ${uniqueInAd.length} packages:`, uniqueInAd);
          emitProgress(i + 1, idArray.length, `> ✅ Ad ${i + 1}/${idArray.length}: Found ${uniqueInAd.join(', ')}`);
          for (const pkg of uniqueInAd) {
            allFoundPackagesArray.push(pkg);
            await onPackageFound(pkg);
          }
        } else {
          console.log(`🟡 [DEBUG] [Ad ${i + 1}] FAILURE: No valid packages found.`);
          emitProgress(i + 1, idArray.length, `> ❌ Ad ${i + 1}/${idArray.length}: No mobile package.`);
        }
      } catch (err) {
        console.error(`🔴 [DEBUG] [Ad ${i + 1}] Error:`, err.message);
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}/${idArray.length}: Skipped on timeout.`);
      } finally {
        await withTimeout(adPage.close().catch(() => {}), 3000);
        console.log(`🟢 [DEBUG] [Ad ${i + 1}] Closed ad tab to free RAM.`);
      }

      // Brief 1.2s pacing delay between tabs to avoid bot rate-limiting
      await new Promise(r => setTimeout(r, 1200));
    }

    console.log(`\n🟢 [DEBUG] 9. PIPELINE COMPLETE! Found ${allFoundPackagesArray.length} total package hits.`);
    emitProgress(idArray.length, idArray.length, `> 🎉 Finished! Extracted ${allFoundPackagesArray.length} package hits.`);
    return allFoundPackagesArray;

  } catch (error) {
    console.error('❌ Scanner crashed/aborted:', error.message);
    emitProgress(0, maxAdsToTest, `> 🛑 SCAN ENDED: ${error.message}`);
    return [];
  } finally {
    console.log("🟢 [DEBUG] 10. Cleaning up & closing browser context...");
    await withTimeout(browser.close().catch(() => {}), 5000);
  }
}

module.exports = { scanCompetitor, isValidPackage };