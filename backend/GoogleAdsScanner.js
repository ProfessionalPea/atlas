const { chromium } = require('playwright');

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
      if (isValidPackage(match[1])) found.add(match[1]);
    }
  }

  return [...found];
}

function extractPackageKeys(value) {
  const decoded = decodeForStoreInspection(value);
  const found = new Set();
  const jsonKeyRegex = /(?:packageName|package_name|appId|app_id)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;

  for (const match of decoded.matchAll(jsonKeyRegex)) {
    if (isValidPackage(match[1])) found.add(match[1]);
  }

  return [...found];
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

      adPage.on('request', req => {
        const packages = extractStorePackages(req.url());
        if (packages.length === 0) return;

        let isCreativeFrameRequest = false;
        try {
          const frame = req.frame();
          isCreativeFrameRequest = Boolean(frame && frame !== adPage.mainFrame());
        } catch {}

        const bucket = isCreativeFrameRequest ? primaryPackages : fallbackPackages;
        packages.forEach(pkg => bucket.add(pkg));
      });

      // Keep scripts/XHR alive, but block heavy visual assets.
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
        const creativeFrames = frames.filter(frame => frame !== adPage.mainFrame());

        // Highest-confidence source: explicit Play Store URLs inside the nested
        // creative frames.
        for (const frame of creativeFrames) {
          try {
            const html = await frame.content();
            extractStorePackages(html).forEach(pkg => primaryPackages.add(pkg));
          } catch {}
        }

        // Some creatives expose the package as a JSON key rather than a visible
        // Play Store URL. Only inspect CHILD frames for this fallback; do not scan
        // the advertiser page's giant serialized metadata blob.
        if (primaryPackages.size === 0) {
          for (const frame of creativeFrames) {
            try {
              const html = await frame.content();
              extractPackageKeys(html).forEach(pkg => primaryPackages.add(pkg));
            } catch {}
          }
        }

        // Last-resort fallback: explicit Play Store URLs from the main page or
        // main-frame requests. We intentionally removed the old generic dotted-
        // string regex because it was the source of most multi-package pollution.
        if (primaryPackages.size === 0) {
          try {
            const mainHtml = await adPage.mainFrame().content();
            extractStorePackages(mainHtml).forEach(pkg => fallbackPackages.add(pkg));
          } catch {}
        }

        const uniqueInAd = [...(primaryPackages.size > 0 ? primaryPackages : fallbackPackages)];

        if (uniqueInAd.length > 0) {
          console.log(`🟢 [DEBUG] [Ad ${i + 1}] SUCCESS: Found ${uniqueInAd.length} packages:`, uniqueInAd);
          emitProgress(i + 1, idArray.length, `> ✅ Ad ${i + 1}: Found ${uniqueInAd.length} packages`);
          
          for (const pkg of uniqueInAd) {
            allFoundPackagesArray.push(pkg);
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

module.exports = { scanCompetitor };