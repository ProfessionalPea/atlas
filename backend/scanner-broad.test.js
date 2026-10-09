const assert = require('assert');
const {
  extractBroadPackages,
  extractExplicitStorePackages,
  buildSafeVideoAttribution
} = require('./GoogleAdsScannerBroad');

function sorted(values) {
  return [...values].sort();
}

// The core September behavior: one creative can expose several games. The ad
// limit must never become a package/game limit.
{
  const html = `
    <a href="https://play.google.com/store/apps/details?id=com.alpha.game">Alpha</a>
    <script>{"packageName":"com.beta.runner","applicationId":"games.gamma.puzzle"}</script>
    <div data-config='{"fallback":"com.delta.arcade.game"}'></div>
  `;
  const packages = extractBroadPackages(html);
  assert.deepStrictEqual(
    sorted(packages),
    sorted(['com.alpha.game', 'com.beta.runner', 'games.gamma.puzzle', 'com.delta.arcade.game'])
  );
}

// Duplicate appearances of the same package must collapse to one discovery.
{
  const html = `
    "com.alpha.game"
    packageName="com.alpha.game"
    https://play.google.com/store/apps/details?id=com.alpha.game
  `;
  assert.deepStrictEqual(extractBroadPackages(html), ['com.alpha.game']);
}

// Known platform/framework namespaces must not become Atlas games.
{
  const html = `
    "com.google.android.gms"
    "com.android.systemui"
    "org.apache.commons.lang3"
    "com.real.mobile.game"
  `;
  assert.deepStrictEqual(extractBroadPackages(html), ['com.real.mobile.game']);
}

// Video attribution stays narrower than discovery: only an explicit Play Store
// package in the exact video frame may claim an asset.
{
  const frameA = {};
  const frameB = {};
  const asset = { source: 'youtube', youtubeId: 'abc12345' };
  const frameEvidence = new Map([
    [frameA, { packages: new Set(['com.alpha.game']), videos: new Map([['youtube:abc12345', asset]]) }],
    [frameB, { packages: new Set(['com.beta.runner']), videos: new Map([['youtube:abc12345', asset]]) }]
  ]);
  const videoMap = new Map([['youtube:abc12345', asset]]);
  const attribution = buildSafeVideoAttribution(frameEvidence, videoMap);
  assert.strictEqual(attribution.packageAssets.size, 0);
  assert.strictEqual(attribution.unassigned.length, 1);
}

{
  const storePackages = extractExplicitStorePackages(
    'https://play.google.com/store/apps/details?id=com.alpha.game&hl=en'
  );
  assert.deepStrictEqual(storePackages, ['com.alpha.game']);
}

console.log('scanner-broad regression tests passed');
