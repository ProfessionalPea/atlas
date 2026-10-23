const assert = require('node:assert/strict');
const {
  resolveCreativePackage,
  extractPackageKeys,
  extractStorePackages,
  isValidPackage
} = require('./GoogleAdsScannerV5');

function evidence({ store = [], metadata = [], visible = [] } = {}) {
  return {
    storePackages: new Set(store),
    metadataPackages: new Set(metadata),
    visiblePackages: new Set(visible),
    videos: new Map(),
    url: ''
  };
}

// Package validation must not assume every Android application ID starts with
// com/io/net/org. Google Play contains valid IDs under many reverse-domain TLDs.
assert.equal(isValidPackage('ai.studio.runner'), true);
assert.equal(isValidPackage('app.publisher.game'), true);
assert.equal(isValidPackage('com.real.game'), true);
assert.equal(isValidPackage('com.google.android.gms'), false);
assert.equal(isValidPackage('not-a-package'), false);

const metadataPackages = extractPackageKeys(`
  <script>
    window.creative = {
      packageName: "com.alpha.game",
      app_id: "ai.beta.runner"
    };
  </script>
`);
assert.deepEqual(new Set(metadataPackages), new Set(['com.alpha.game', 'ai.beta.runner']));

const storePackages = extractStorePackages(
  'https://play.google.com/store/apps/details?id=com.alpha.game&hl=en'
);
assert.deepEqual(storePackages, ['com.alpha.game']);

// Multiple metadata packages are all retained for discovery. Ownership is not
// guessed when there is no stronger CTA/store evidence.
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

// A single metadata package restores the old fallback so packages do not get
// lost merely because Google omitted a literal Play Store href.
{
  const resolution = resolveCreativePackage(
    new Set(),
    new Set(['com.alpha.game']),
    new Map()
  );
  assert.equal(resolution.packageName, 'com.alpha.game');
  assert.equal(resolution.reason, 'single_metadata_package_fallback');
}

// Strong Play Store evidence owns the creative, while additional metadata
// packages remain discoverable as separate games.
{
  const resolution = resolveCreativePackage(
    new Set(['com.alpha.game']),
    new Set(['ai.beta.runner']),
    new Map()
  );
  assert.equal(resolution.packageName, 'com.alpha.game');
  assert.equal(resolution.reason, 'single_store_candidate_fallback');
  assert.deepEqual(
    new Set(resolution.discoveredPackages),
    new Set(['com.alpha.game', 'ai.beta.runner'])
  );
}

// Conflicting visible CTAs are never collapsed into an arbitrary owner.
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

console.log('scanner-v5 regression tests passed');
