const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function solveCaptcha() {
  const profileDir = process.env.ATLAS_SCANNER_PROFILE_DIR || path.join(__dirname, '.playwright_transparency_profile');
  const cookiesFilePath = path.join(__dirname, 'google_cookies.json');

  fs.mkdirSync(profileDir, { recursive: true });
  console.log('Opening Google Ads Transparency Center in visible Chrome profile...');
  console.log('Profile directory:', profileDir);

  const launchOpts = {
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US'
  };

  const context = await chromium
    .launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' })
    .catch(() => chromium.launchPersistentContext(profileDir, launchOpts));

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://adstransparency.google.com/?region=any', { waitUntil: 'domcontentloaded' });

  console.log('\n👉 If a Google CAPTCHA ("unusual traffic" / sorry/index) is shown in the opened browser window, please solve it now.');
  console.log('Waiting up to 180 seconds for adstransparency.google.com to load cleanly...');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (
      currentUrl.includes('adstransparency.google.com') &&
      !currentUrl.includes('google.com/sorry')
    ) {
      // Wait 3s for cookies to settle
      await new Promise(r => setTimeout(r, 3000));
      const checkUrl = page.url();
      if (checkUrl.includes('adstransparency.google.com') && !checkUrl.includes('google.com/sorry')) {
        const cookies = await context.cookies();
        const googleCookies = cookies.filter(c => c.domain && c.domain.includes('google.com'));
        fs.writeFileSync(cookiesFilePath, JSON.stringify(googleCookies, null, 2), 'utf8');
        console.log(`\n✅ CAPTCHA cleared! Saved ${googleCookies.length} Google session cookies to ${cookiesFilePath}.`);
        await context.close();
        process.exit(0);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.error('\n⚠️ Timed out waiting for CAPTCHA clearance.');
  await context.close();
  process.exit(1);
}

solveCaptcha().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
