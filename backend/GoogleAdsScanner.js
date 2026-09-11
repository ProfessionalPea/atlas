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

// NOTICE: Added onPackageFound callback parameter
async function scanCompetitor(searchQuery, targetCountry, maxAdsToTest = 500, onProgress = () => {}, onPackageFound = async () => {}, isCancelled = () => false) {
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
  // CHANGE THIS FROM 'const browser' TO 'let browser'
  let browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',                  
      '--no-zygote',                    
      '--single-process',               
      '--disable-site-isolation-trials' 
    ]
  });

  console.log("🟢 [DEBUG] 2. Creating Stealth Context...");
  // CHANGE THIS FROM 'const context' TO 'let context'
  let context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  // This first page is strictly for searching and sniffing the IDs
  const searchPage = await context.newPage();

  console.log("🟢 [DEBUG] 3. Applying RAM Optimizations...");
  await searchPage.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    searchPage.setDefaultTimeout(120000);
    searchPage.setDefaultNavigationTimeout(120000);

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
      await searchPage.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await searchPage.waitForTimeout(4000);
    } else {
      console.log(`🟢 [DEBUG] 5. Search query detected ("${query}"). Navigating to Google Ads Transparency search...`);
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);
      await searchPage.goto('https://adstransparency.google.com/?region=any', { waitUntil: 'domcontentloaded', timeout: 60000 });

      const searchBox = searchPage.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click();
      await searchBox.fill(query);

      let dropdownOption;
      if (!targetCountry || targetCountry.toLowerCase() === 'any' || targetCountry.includes('Any')) {
        dropdownOption = searchPage.locator(`text=/${query}/i`).first();
      } else {
        dropdownOption = searchPage.locator(`text=/${targetCountry}/i`).first();
      }

      await dropdownOption.waitFor({ state: 'visible', timeout: 15000 });
      await searchPage.waitForTimeout(1000);

      hasClicked = true;
      await dropdownOption.click();
      emitProgress(0, maxAdsToTest, `> 🖱️ Clicked! Sniffing network for true AR ID...`);

      let timeWaited = 0;
      while (!arId && timeWaited < 15000) {
        if (isCancelled()) break;
        await searchPage.waitForTimeout(1000);
        timeWaited += 1000;
      }

      if (isCancelled()) throw new Error('Scan aborted by user.');
      if (!arId) throw new Error('Failed to intercept true AR ID.');
      
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
      await searchPage.waitForTimeout(3000);

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

    // We have our IDs. We can safely close the search page to free up RAM!
    await searchPage.close(); 
    console.log(`🟢 [DEBUG] Closed search page to free RAM.`);

    const idArray = Array.from(adIds).slice(0, maxAdsToTest);
    console.log(`🟢 [DEBUG] 7. Scroll phase complete. Moving to deep extraction loop...`);
    emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads! Moving to deep extraction...`);

    let allFoundPackagesArray = []; // Tracks every instance to return to server.js at the end

    for (let i = 0; i < idArray.length; i++) {
      // ---------------------------------------------------------
      if (isCancelled()) {
        emitProgress(i + 1, idArray.length, '> 🛑 Abort signal received. Terminating deep extraction...');
        break;
      }

      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;

      // CREATE EPHEMERAL PAGE FOR THIS SINGLE AD
      const adPage = await context.newPage();

      const adFoundPackages = [];
      
      // Sniff click redirect URLs that fire inside the ad iframes
      adPage.on('request', req => {
        const reqUrl = req.url();
        const storeUrlRegex = /(?:id=|id%3D|details\?id=|details%3Fid%3D|market:\/\/details\?id=)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/i;
        const match = reqUrl.match(storeUrlRegex);
        if (match && isValidPackage(match[1])) {
          adFoundPackages.push(match[1]);
        }
      });
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
        } catch (error) {
          console.log(`🔴 [DEBUG] [Ad ${i + 1}] Page load timed out, but proceeding with scraping anyway...`);
        }

        await adPage.waitForTimeout(5000);
        await adPage.waitForTimeout(3000);

        const frames = adPage.frames();
        let fullHtml = '';
        for (const frame of frames) {
          try { fullHtml += await frame.content(); } catch (e) {}
        }
        
        let adFoundPackages = [];

        const storeUrlRegex = /(?:id=|id%3D|details\?id=|details%3Fid%3D|market:\/\/details\?id=)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi;
        for (const m of fullHtml.matchAll(storeUrlRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        const jsonKeyRegex = /(?:packageName|package_name|appId|app_id|bundleId)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;
        for (const m of fullHtml.matchAll(jsonKeyRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        const delimitedRegex = /["'`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})["'`]/g;
        for (const m of fullHtml.matchAll(delimitedRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        const uniqueInAd = [...new Set(adFoundPackages)];

        if (uniqueInAd.length > 0) {
          console.log(`🟢 [DEBUG] [Ad ${i + 1}] SUCCESS: Found ${uniqueInAd.length} packages:`, uniqueInAd);
          emitProgress(i + 1, idArray.length, `> ✅ Ad ${i + 1}: Found ${uniqueInAd.length} packages`);
          
          // EAGERLY SEND TO SERVER.JS DATABASE
          for (const pkg of uniqueInAd) {
            allFoundPackagesArray.push(pkg);
            await onPackageFound(pkg); 
          }
        } else {
          console.log(`🟡 [DEBUG] [Ad ${i + 1}] FAILURE: No valid packages found.`);
          emitProgress(i + 1, idArray.length, `> ❌ Ad ${i + 1}: No valid package found.`);
        }
      } catch (error) {
        console.error(`🔴 [DEBUG] [Ad ${i + 1}] Unexpected Error:`, error.message);
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}: Timeout. Skipping.`);
      } finally {
        // THE MAGIC RAM BULLET: Destroy the page after extraction
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