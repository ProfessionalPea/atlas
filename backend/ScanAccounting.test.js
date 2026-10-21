const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_ADS_PER_SCAN,
  resolveTargetUniqueGames,
  resolveMaxAdsToInspect,
  createScanAccounting
} = require("./ScanAccounting");

test("normalizes the requested unique-game target", () => {
  assert.equal(resolveTargetUniqueGames("100"), 100);
  assert.equal(resolveTargetUniqueGames(2.9), 2);
  assert.equal(resolveTargetUniqueGames(0), 1);
  assert.equal(resolveTargetUniqueGames("not a number"), 1);
});

test("uses a configurable ad-inspection safety cap with a hard ceiling", () => {
  assert.equal(resolveMaxAdsToInspect(250), 250);
  assert.equal(resolveMaxAdsToInspect(9000), 5000);
  assert.equal(resolveMaxAdsToInspect(0), DEFAULT_MAX_ADS_PER_SCAN);
  assert.equal(resolveMaxAdsToInspect("invalid"), DEFAULT_MAX_ADS_PER_SCAN);
});

test("counts package IDs once per scan and identifies creative duplicates", () => {
  const accounting = createScanAccounting(3, 500);

  accounting.markInspected();
  assert.deepEqual(accounting.recordPackages(["com.example.game", "COM.example.game", "com.example.runner"]), {
    newPackages: ["com.example.game", "com.example.runner"],
    isDuplicateAd: false,
    uniqueGamesFound: 2
  });

  accounting.markInspected();
  assert.deepEqual(accounting.recordPackages(["com.example.game"]), {
    newPackages: [],
    isDuplicateAd: true,
    uniqueGamesFound: 2
  });

  accounting.markInspected();
  assert.deepEqual(accounting.recordPackages([]), {
    newPackages: [],
    isDuplicateAd: false,
    uniqueGamesFound: 2
  });

  assert.deepEqual(accounting.getSnapshot(), {
    targetUniqueGames: 3,
    uniqueGamesFound: 2,
    adsInspected: 3,
    duplicateAds: 1,
    adsWithoutPackages: 1,
    maxAdsToInspect: 500
  });
  assert.equal(accounting.hasReachedTarget(), false);
});

test("stops only after the current scan reaches its unique-game target", () => {
  const accounting = createScanAccounting(2, 500);
  accounting.recordPackages(["com.example.one"]);
  assert.equal(accounting.hasReachedTarget(), false);
  accounting.recordPackages(["com.example.one", "com.example.two"]);
  assert.equal(accounting.hasReachedTarget(), true);
});
