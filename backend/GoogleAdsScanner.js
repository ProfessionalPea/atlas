const { chromium } = require('playwright');

// Helper to filter out JavaScript noise and only allow real Play Store package names
function isValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;

  const lower = pkg.toLowerCase();

  // 1. Must start with a known mobile package prefix
  const validPrefixes = ['com.', 'io.', 'net.', 'org.', 'games.'];
  if (!validPrefixes.some(prefix => lower.startsWith(prefix))) return false;

  // 2. Strict Blacklist for Google Ad scripts, frameworks, and OS libraries
  const blacklist = [
    'goog.',
    'com.google.',
    'com.android.',
    'com.apple.',
    'org.w3c.',
    'org.apache.',
    'io.github.'
  ];
  if (blacklist.some(bad => lower.startsWith(bad))) return false;

  // 3. Filter out JS files, assets, and uppercase Closure constants (e.g. PLATFORM_KNOWN_)
  if (pkg.includes('_KNOWN_') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.png')) {
    return false;
  }

  // 4. Must consist of at least two segments (e.g., prefix.name)
  const segments = pkg.split('.');
  if (segments.length < 2) return false;

  return true;
}

async function scanCompetitor(searchQuery, targetCountry, maxAdsToTest = 5) {
  const query = searchQuery.trim();
  console.log(`\n🚀 [Master Scanner] Starting full pipeline for: "${query}"`);
  
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    let arId = null;
    let adIds = new Set();
    let hasClicked = false; 

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
      console.log(`✅ [1/3] Direct Advertiser ID detected: ${arId}. Bypassing search phase!`);
      hasClicked = true; 
      await page.goto(`https://adstransparency.google.com/advertiser/${arId}?region=any`);
      await page.waitForTimeout(4000); 

    } else {
      // ==========================================
      // BLOCK 1: THE HUMAN SEARCH 
      // ==========================================
      console.log(`🔎 [1/3] Searching for "${query}"...`);
      await page.goto('https://adstransparency.google.com/?region=any');

      const searchBox = page.getByRole('textbox').first();
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.click(); 
      await searchBox.fill(query);

      let dropdownOption;
      if (!targetCountry || targetCountry.toLowerCase() === "any") {
        console.log("🌍 'Any Country' selected. Grabbing the first fuzzy match...");
        dropdownOption = page.locator(`text=/${query}/i`).first(); 
      } else {
        dropdownOption = page.locator(`text=/${targetCountry}/i`).first();
      }

      await dropdownOption.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(1000); 
      
      hasClicked = true; 
      await dropdownOption.click();
      console.log("🖱️ [1/3] Clicked! Sniffing network for the true Advertiser ID...");

      let timeWaited = 0;
      while (!arId && timeWaited < 15000) {
        await page.waitForTimeout(1000); 
        timeWaited += 1000;
      }

      if (!arId) throw new Error("Failed to intercept true AR ID from network traffic.");
      console.log(`✅ [1/3] Locked onto TRUE Advertiser ID: ${arId}`);
    }

    // ==========================================
    // BLOCK 2: THE SMART SCROLL
    // ==========================================
    console.log(`🎧 [2/3] Scrolling to intercept at least ${maxAdsToTest} Ad IDs...`);
    
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
        console.log(`   ... intercepted ${adIds.size} ads so far...`);
      }
    }

    const idArray = Array.from(adIds).slice(0, maxAdsToTest);
    console.log(`✅ [2/3] Intercepted ${idArray.length} ads! Moving to extraction...`);

    // ==========================================
    // BLOCK 3: THE PACKAGE EXTRACTOR
    // ==========================================
    console.log(`🕵️ [3/3] Deep-scanning ${idArray.length} ads for Play Store packages...`);
    let foundPackages = new Set();

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

        // 1. Play Store URL patterns (highest accuracy)
        const storeUrlRegex = /(?:id=|id%3D|details\?id=|details%3Fid%3D|market:\/\/details\?id=)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/gi;
        for (const m of fullHtml.matchAll(storeUrlRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        // 2. JSON & Data attribute keys
        const jsonKeyRegex = /(?:packageName|package_name|appId|app_id|bundleId)["']?\s*[:=]\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/gi;
        for (const m of fullHtml.matchAll(jsonKeyRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        // 3. Delimited package names in HTML attributes or strings
        const delimitedRegex = /["'`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){2,})["'`]/g;
        for (const m of fullHtml.matchAll(delimitedRegex)) {
          if (isValidPackage(m[1])) adFoundPackages.push(m[1]);
        }

        // Deduplicate what we found in this single ad
        const uniqueInAd = [...new Set(adFoundPackages)];

        if (uniqueInAd.length > 0) {
          uniqueInAd.forEach(pkg => foundPackages.add(pkg));
          console.log(`   ✅ Ad ${i + 1}/${idArray.length}: Found ${uniqueInAd.join(', ')}`);
        } else {
          console.log(`   ❌ Ad ${i + 1}/${idArray.length}: No valid package found.`);
        }
      } catch (error) {
        console.log(`   ⚠️ Ad ${i + 1}/${idArray.length}: Timeout or network error. Skipping.`);
      }
    }

    const packagesArray = Array.from(foundPackages);
    console.log(`\n🎉 [Master Scanner] Finished! Found ${packagesArray.length} unique packages.`);
    return packagesArray;

  } catch (error) {
    console.error("❌ Scanner crashed:", error.message);
    return []; 
  } finally {
    console.log("🛑 Closing browser...");
    await browser.close();
  }
}

module.exports = { scanCompetitor };