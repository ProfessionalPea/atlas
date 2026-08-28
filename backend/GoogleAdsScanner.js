const { chromium } = require('playwright');

// Helper to filter out JavaScript noise and only allow real Play Store package names
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

// NOTICE: Added onProgress = () => {}
async function scanCompetitor(searchQuery, targetCountry, maxAdsToTest = 500, onProgress = () => {}) {
  const query = searchQuery.trim();
  console.log(`\n🚀 [Master Scanner] Starting full pipeline for: "${query}"`);
  
  // --- ETA CALCULATOR ---
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
    // Broadcast to the frontend
    onProgress({ currentAd: current, totalAds: total, timeRemaining, log: logMsg });
  };

  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    let arId = null;
    let adIds = new Set();
    let hasClicked = false; 

    // Emit initial boot-up
    emitProgress(0, maxAdsToTest, `> 🚀 Booting scanner for: "${query}"`);

    // THE OMNI-SPY
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (url.includes('SearchAdvertisers')) return;

        if (hasClicked && (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch')) {
          if (!arId) {
            const postData = res.request().postData() || '';
            const match = url.match(/(AR[0-9]{15,})/) || postData.match(/(AR[0-9]{15,})/);
            if (match) arId = match[1];
          }

          const text = await res.text();
          if (!arId) {
            const textMatch = text.match(/(AR[0-9]{15,})/);
            if (textMatch) arId = textMatch[1];
          }

          const crMatches = [...text.matchAll(/"(CR[0-9]+)"/g)];
          crMatches.forEach(m => adIds.add(m[1]));
        }
      } catch (e) {}
    });

    const isDirectId = /^AR[0-9]{15,}$/i.test(query);

    if (isDirectId) {
      arId = query.toUpperCase();
      emitProgress(0, maxAdsToTest, `> ✅ Direct ID detected: ${arId}. Bypassing search...`);
      hasClicked = true; 
      await page.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`);
      await page.waitForTimeout(4000); 
    } else {
      emitProgress(0, maxAdsToTest, `> 🔎 Searching Google Ads for "${query}"...`);
      await page.goto('https://adstransparency.google.com/?region=any');

      const searchBox = page.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click(); 
      await searchBox.fill(query);

      let dropdownOption;
      if (!targetCountry || targetCountry.toLowerCase() === "any" || targetCountry.includes("Any")) {
        dropdownOption = page.locator(`text=/${query}/i`).first(); 
      } else {
        dropdownOption = page.locator(`text=/${targetCountry}/i`).first();
      }

      await dropdownOption.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(1000); 
      
      hasClicked = true; 
      await dropdownOption.click();
      emitProgress(0, maxAdsToTest, `> 🖱️ Clicked! Sniffing network for true AR ID...`);

      let timeWaited = 0;
      while (!arId && timeWaited < 15000) {
        await page.waitForTimeout(1000); 
        timeWaited += 1000;
      }

      if (!arId) throw new Error("Failed to intercept true AR ID.");
      emitProgress(0, maxAdsToTest, `> ✅ Locked onto Advertiser ID: ${arId}`);
    }

    emitProgress(0, maxAdsToTest, `> 🎧 Scrolling to intercept ${maxAdsToTest} ads...`);
    
    let strikes = 0;
    let previousSize = 0;

    while (adIds.size < maxAdsToTest && strikes < 3) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(3000); 

      if (adIds.size === previousSize) {
        strikes++;
      } else {
        strikes = 0;
        previousSize = adIds.size;
        emitProgress(0, maxAdsToTest, `> ... intercepted ${adIds.size} ads so far...`);
      }
    }

    const idArray = Array.from(adIds).slice(0, maxAdsToTest);
    emitProgress(0, idArray.length, `> ✅ Intercepted ${idArray.length} ads! Moving to deep extraction...`);

    let foundPackages = new Set();

    // The heavy lifting: This is where the progress bar physically moves
    for (let i = 0; i < idArray.length; i++) {
      const adId = idArray[i];
      const url = `https://adstransparency.google.com/advertiser/${arId}/creative/${adId}?region=any`;

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000); 

        const frames = page.frames();
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
          uniqueInAd.forEach(pkg => foundPackages.add(pkg));
          // Progress bar moves up here
          emitProgress(i + 1, idArray.length, `> ✅ Ad ${i + 1}: Found ${uniqueInAd.length} packages`);
        } else {
          // Progress bar moves up here too
          emitProgress(i + 1, idArray.length, `> ❌ Ad ${i + 1}: No valid package found.`);
        }
      } catch (error) {
        emitProgress(i + 1, idArray.length, `> ⚠️ Ad ${i + 1}: Timeout. Skipping.`);
      }
    }

    const packagesArray = Array.from(foundPackages);
    emitProgress(idArray.length, idArray.length, `> 🎉 Finished! Extracted ${packagesArray.length} unique packages.`);
    
    return packagesArray;

  } catch (error) {
    console.error("❌ Scanner crashed:", error.message);
    emitProgress(0, maxAdsToTest, `> ❌ CRASH: ${error.message}`);
    return []; 
  } finally {
    await browser.close();
  }
}

module.exports = { scanCompetitor };