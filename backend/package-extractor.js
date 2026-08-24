const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log("🚀 Launching Package Extractor...");
  const browser = await chromium.launch({ headless: true }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("📂 Loading saved Ad IDs...");
  const adIds = JSON.parse(fs.readFileSync('playmax_ads.json', 'utf8'));
  
  const testBatch = adIds.slice(0, 5); 
  const advertiserId = "AR07632638642883657729"; // Playmax
  
  let foundPackages = new Set();

  console.log(`🕵️ Testing extraction on ${testBatch.length} ads...\n`);

  for (let i = 0; i < testBatch.length; i++) {
    const adId = testBatch[i];
    const url = `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${adId}?region=any`;

    console.log(`🌐 [${i + 1}/${testBatch.length}] Visiting Ad: ${adId}`);
    
    // THE SAFETY NET: If one ad fails, catch the error and keep going
    try {
      // THE SPEED TWEAK: Don't wait for images/trackers, just the DOM. Timeout after 15s.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000); // Give the JS 3 seconds to inject the iframes

      const frames = page.frames();
      let fullHtml = '';
      for (const frame of frames) {
        try { fullHtml += await frame.content(); } catch (e) {}
      }

      const urlRegex = /id(?:=|%3D)([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)/g;
      const jsonRegex = /"(com\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g;

      const matches1 = [...fullHtml.matchAll(urlRegex)].map(m => m[1]);
      const matches2 = [...fullHtml.matchAll(jsonRegex)].map(m => m[1]);
      
      const matches = [...new Set([...matches1, ...matches2])];

      if (matches.length > 0) {
        console.log(`   ✅ Found package: ${matches[0]}`);
        foundPackages.add(matches[0]);
      } else {
        console.log(`   ❌ No package found (might be suspended or video-only)`);
      }
    } catch (error) {
      console.log(`   ⚠️ Failed to load ad (Timeout or Network Error). Skipping.`);
    }
  }

console.log(`\n🎉 Extractor complete! Found ${foundPackages.size} unique packages from ${testBatch.length} ads.`);
  foundPackages.forEach(pkg => console.log(`  📦 ${pkg}`));

  // --- NEW CODE: Save the extracted packages to a file ---
  const packagesArray = Array.from(foundPackages);
  fs.writeFileSync('extracted_packages.json', JSON.stringify(packagesArray, null, 2));
  console.log("💾 Saved packages to C:\\Atlas\\backend\\extracted_packages.json");
  // -------------------------------------------------------

  console.log("\n🛑 Closing browser...");
  await browser.close();
})();