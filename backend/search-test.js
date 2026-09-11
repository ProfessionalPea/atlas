const { chromium } = require('playwright');

(async () => {
  console.log("🚀 Launching Human-like Searcher...");
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  const searchQuery = "Playmax"; 
  const targetCountry = "Pakistan"; // We use this to click the right dropdown option!

  console.log(`🔎 Searching Google Ads for: "${searchQuery}"...`);
  await page.goto('https://adstransparency.google.com/?region=any');

  // 1. Find the search box and type
  const searchBox = page.getByRole('textbox').first();
  await searchBox.waitFor({ state: 'visible', timeout: 15000 });
  await searchBox.click(); 
  await searchBox.fill(searchQuery);

  console.log(`👀 Waiting for dropdown to show "${targetCountry}"...`);

  // 2. Wait for the specific dropdown option to appear on screen and click it!
  // We use a locator that finds any text containing "Pakistan" inside the dropdown
  const dropdownOption = page.locator(`text="${targetCountry}"`).first();
  await dropdownOption.waitFor({ state: 'visible', timeout: 10000 });
  await dropdownOption.click();

  console.log("🖱️ Clicked! Waiting for the advertiser page to load...");

  // 3. Wait for the URL to change to the Advertiser page
  await page.waitForURL('**/advertiser/AR**');

  // 4. Rip the ID right out of the URL!
  const finalUrl = page.url();
  console.log(`\n🔗 Arrived at URL: ${finalUrl}`);

  const arRegex = /(AR[0-9]{15,})/;
  const match = finalUrl.match(arRegex);

  if (match) {
    console.log(`\n🎉 SUCCESS! Extracted Advertiser ID: ${match[1]}`);
  } else {
    console.log(`\n❌ Failed to extract AR ID from the URL.`);
  }

  console.log("\n🛑 Closing browser...");
  await browser.close();
})();