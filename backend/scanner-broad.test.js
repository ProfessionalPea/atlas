const assert = require('assert');
const {
  extractBroadPackages,
  extractExplicitStorePackages,
  buildSafeVideoAttribution
} = require('./GoogleAdsScannerBroad');

function sorted(values) {
  return [...values].sort();
}

// One creative can expose several com.* games. Non-com namespaces must always be rejected.
{
  const html = `
    <a href="https://play.google.com/store/apps/details?id=com.alpha.game">Alpha</a>
    <script>{"packageName":"com.beta.runner","applicationId":"games.gamma.puzzle"}</script>
    <div data-config='{"fallback":"com.delta.arcade.game"}'></div>
  `;
  const packages = extractBroadPackages(html);
  assert.deepStrictEqual(
    sorted(packages),
    sorted(['com.alpha.game', 'com.beta.runner', 'com.delta.arcade.game'])
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

// Google Search Ads Viewer can put app IDs inside escaped script and c-wiz
// initialization payloads, even when no install CTA / Play Store URL is present.
{
  const nestedScriptPayload = '<script>AF_initDataCallback("{\\"appId\\":\\"com.dolphingames.subway.sneak.out\\",\\"label\\":\\"Girl Escape\\"}")</script>';
  const cWizPayload = '<c-wiz data-p="\\\\u0022packageName\\\\u0022:\\\\u0022app.girl.escape.game\\\\u0022"></c-wiz>';
  const packages = extractBroadPackages(nestedScriptPayload + cWizPayload);
  assert.deepStrictEqual(
    sorted(packages),
    sorted(['com.dolphingames.subway.sneak.out'])
  );
}

// Named metadata fields do not bypass Atlas's com.* namespace requirement.
{
  const html = '<script>{"applicationId":"mobile.vendor.girl.escape"}</script>';
  assert.deepStrictEqual(extractBroadPackages(html), []);
}

// Strong evidence does not bypass the com.* namespace rule.
{
  const html = `
    <a href="https://play.google.com/store/apps/details?id=io.vendor.game">Non-com destination</a>
    <script>{"appId":"net.vendor.game","packageName":"com.allowed.game"}</script>
    <c-wiz data-p="org.vendor.game"></c-wiz>
  `;
  assert.deepStrictEqual(extractBroadPackages(html), ['com.allowed.game']);
  assert.deepStrictEqual(
    extractExplicitStorePackages('https://play.google.com/store/apps/details?id=io.vendor.game'),
    []
  );
}

// Unquoted app IDs inside renderer markup should still be detected.
{
  const html = '<c-wiz data-p="com.dolphingames.subway.sneak.out"></c-wiz>';
  assert.deepStrictEqual(extractBroadPackages(html), ['com.dolphingames.subway.sneak.out']);
}

console.log('scanner-broad regression tests passed');
