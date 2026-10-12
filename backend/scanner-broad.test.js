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

// Google Search Ads Viewer can put app IDs inside escaped script and c-wiz
// initialization payloads, even when no install CTA / Play Store URL is present.
{
  const nestedScriptPayload = String.raw\`<script>AF_initDataCallback("{\\"appId\\":\\"com.dolphingames.subway.sneak.out\\",\\"label\\":\\"Girl Escape\\"}")</script>\`;
  const cWizPayload = String.raw\`<c-wiz data-p="\\\\u0022packageName\\\\u0022:\\\\u0022app.girl.escape.game\\\\u0022"></c-wiz>\`;
  const packages = extractBroadPackages(nestedScriptPayload + cWizPayload);
  assert.deepStrictEqual(
    sorted(packages),
    sorted(['com.dolphingames.subway.sneak.out', 'app.girl.escape.game'])
  );
}

// Metadata-key evidence can use valid package namespaces beyond the original
// short prefix allowlist; generic dotted strings remain namespace-filtered.
{
  const html = '<script>{"applicationId":"mobile.vendor.girl.escape"}</script>';
  assert.deepStrictEqual(extractBroadPackages(html), ['mobile.vendor.girl.escape']);
}

// Unquoted app IDs inside renderer markup should still be detected.
{
  const html = '<c-wiz data-p="com.dolphingames.subway.sneak.out"></c-wiz>';
  assert.deepStrictEqual(extractBroadPackages(html), ['com.dolphingames.subway.sneak.out']);
}

console.log('scanner-broad regression tests passed');
