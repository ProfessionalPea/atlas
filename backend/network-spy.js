const { chromium } = require('playwright');
const fs = require('fs'); // Node's built-in File System module

(async () => {
  console.log("🚀 Launching Network Spy...");
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  let adIds = new Set();

  console.log("🎧 Eavesdropping on Google's background API traffic...");

  page.on('response', async (response) => {
    try {
      if (response.request().resourceType() === 'xhr' || response.request().resourceType() === 'fetch') {
        const body = await response.text();
        const crRegex = /"(CR[0-9]+)"/g;
        const matches = [...body.matchAll(crRegex)];
        matches.forEach(m => adIds.add(m[1]));
      }
    } catch (e) {
      // Ignore
    }
  });

  console.log("🌐 Navigating directly to Playmax...");
  await page.goto('https://adstransparency.google.com/advertiser/AR07632638642883657729?region=any');
  
  // Wait a bit longer initially for the first batch of ads to load
  await page.waitForTimeout(5000); 

  console.log("⏳ Starting Smart Scroll...");
  
  let previousSize = 0;
  let strikes = 0;
  const MAX_STRIKES = 3; // Stop if 3 scrolls happen with no new ads

  // Infinite loop that only breaks when we hit the bottom
  while (true) {
    // Scroll down a massive amount
    await page.mouse.wheel(0, 5000);
    
    // Wait 3 seconds for Google's API to fetch the new ads
    await page.waitForTimeout(10000); 
    
    console.log(`   ... intercepted ${adIds.size} ads so far...`);

    if (adIds.size === previousSize) {
      strikes++;
      console.log(`   ⚠️ No new ads loaded. Strike ${strikes}/${MAX_STRIKES}`);
      if (strikes >= MAX_STRIKES) {
        console.log("🛑 Reached the bottom or ads stopped loading. Ending scroll.");
        break; 
      }
    } else {
      // We found new ads! Reset the strikes.
      strikes = 0;
      previousSize = adIds.size;
    }
  }

  console.log(`\n🎉 Spy Complete! Successfully extracted ${adIds.size} unique Ad IDs!`);
  
  // Save all of them to a physical file on your laptop
  const idArray = Array.from(adIds);
  fs.writeFileSync('playmax_ads.json', JSON.stringify(idArray, null, 2));
  console.log("💾 Saved all IDs to C:\\Atlas\\backend\\playmax_ads.json");

  console.log("\n🛑 Closing browser...");
  await browser.close();
})();