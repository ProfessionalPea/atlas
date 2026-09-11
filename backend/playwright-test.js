const { chromium } = require('playwright');
const SHOW_BROWSER = false;

(async () => {
  console.log("🚀 Launching automated browser...");
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("🌐 Navigating to Google Ads Transparency Center...");
  await page.goto('https://adstransparency.google.com/advertiser/AR07632638642883657729');
  
  console.log("⏳ You have 30 seconds!");
  console.log("👉 1. Search Playmax");
  console.log("👉 2. Click their profile");
  console.log("👉 3. CLICK INTO A SINGLE AD so it opens on the screen.");
  
  await page.waitForTimeout(30000); 

  console.log("🕵️ Scanning the main page AND all hidden iframes...");
  
  // 1. Vacuum HTML from ALL frames
  const frames = page.frames();
  let fullHtml = '';
  for (const frame of frames) {
    try {
      fullHtml += await frame.content();
    } catch (e) {
      // Ignore cross-origin frames we can't read
    }
  }

  // 2. Extract using two different patterns based on your research
  const urlRegex = /id(?:=|%3D)([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)/g;
  const jsonRegex = /"(com\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g;

  const matches1 = [...fullHtml.matchAll(urlRegex)].map(m => m[1]);
  const matches2 = [...fullHtml.matchAll(jsonRegex)].map(m => m[1]);

  const uniquePackages = [...new Set([...matches1, ...matches2])];

  console.log(`\n🎉 Found ${uniquePackages.length} unique Play Store packages!`);
  uniquePackages.forEach((pkg, index) => {
    console.log(`  ${index + 1}. ${pkg}`);
  });

  console.log("\n🛑 Closing browser...");
  await browser.close();
})();