const assert = require('node:assert/strict');
const {
  resolveCreativePackage,
  extractPackageKeys,
  extractStorePackages,
  isValidPackage,
  decodeForInspection
} = require('./GoogleAdsScannerV6');

function evidence({ store = [], metadata = [], visible = [] } = {}) {
  return {
    storePackages: new Set(store),
    metadataPackages: new Set(metadata),
    visiblePackages: new Set(visible),
    videos: new Map(),
    url: ''
  };
}

assert.equal(isValidPackage('ai.studio.runner'), true);
assert.equal(isValidPackage('app.publisher.game'), true);
assert.equal(isValidPackage('com.google.android.gms'), false);

// Google creative payloads frequently contain JSON nested inside another
// encoded/escaped string. v6 must recover package keys from that representation.
const escaped = String.raw`{\"androidPackageName\":\"ai.studio.runner\",\"application_id\":\"app.publisher.game\"}`;
assert.match(decodeForInspection(escaped), /androidPackageName/);
assert.deepEqual(
  new Set(extractPackageKeys(escaped)),
  new Set(['ai.studio.runner', 'app.publisher.game'])
);

// Encoded redirect destinations must still count as strong Play Store evidence.
assert.deepEqual(
  extractStorePackages('https://example.test/redirect?url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.real.game%26hl%3Den'),
  ['com.real.game']
);

// Multi-package discovery remains broad while ownership remains strict.
{
  const resolution = resolveCreativePackage(
    new Set(),
    new Set(['com.alpha.game', 'ai.beta.runner']),
    new Map()
  );
  assert.equal(resolution.packageName, null);
  assert.equal(resolution.reason, 'multiple_packages_discovered');
  assert.deepEqual(
    new Set(resolution.discoveredPackages),
    new Set(['com.alpha.game', 'ai.beta.runner'])
  );
}

// One visible Play destination still wins ownership even when another package
// is found only as metadata.
{
  const frame = {};
  const frames = new Map([
    [frame, evidence({ store: ['com.alpha.game'], visible: ['com.alpha.game'] })]
  ]);
  const resolution = resolveCreativePackage(
    new Set(['com.alpha.game']),
    new Set(['ai.beta.runner']),
    frames
  );
  assert.equal(resolution.packageName, 'com.alpha.game');
  assert.equal(resolution.reason, 'visible_play_store_cta');
  assert.deepEqual(
    new Set(resolution.discoveredPackages),
    new Set(['com.alpha.game', 'ai.beta.runner'])
  );
}

// Conflicting visible destinations are never guessed into one owner.
{
  const frameA = {};
  const frameB = {};
  const frames = new Map([
    [frameA, evidence({ store: ['com.alpha.game'], visible: ['com.alpha.game'] })],
    [frameB, evidence({ store: ['ai.beta.runner'], visible: ['ai.beta.runner'] })]
  ]);
  const resolution = resolveCreativePackage(
    new Set(['com.alpha.game', 'ai.beta.runner']),
    new Set(),
    frames
  );
  assert.equal(resolution.packageName, null);
  assert.equal(resolution.reason, 'multiple_visible_play_store_ctas');
}

console.log('scanner-v6 regression tests passed');
