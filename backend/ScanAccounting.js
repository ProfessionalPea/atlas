const DEFAULT_MAX_ADS_PER_SCAN = 500;
const HARD_MAX_ADS_PER_SCAN = 5000;

function resolveTargetUniqueGames(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function resolveMaxAdsToInspect(value = process.env.ATLAS_MAX_ADS_PER_SCAN) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ADS_PER_SCAN;
  return Math.min(parsed, HARD_MAX_ADS_PER_SCAN);
}

function createScanAccounting(targetValue, maxAdsValue) {
  const targetUniqueGames = resolveTargetUniqueGames(targetValue);
  const maxAdsToInspect = resolveMaxAdsToInspect(maxAdsValue);
  const uniquePackageKeys = new Set();
  let adsInspected = 0;
  let duplicateAds = 0;
  let adsWithoutPackages = 0;

  function markInspected() {
    adsInspected += 1;
    return getSnapshot();
  }

  function recordPackages(packages) {
    const packageKeys = [...new Set(
      (Array.isArray(packages) ? packages : [])
        .filter(pkg => typeof pkg === "string" && pkg.trim())
        .map(pkg => pkg.trim().toLowerCase())
    )];

    if (packageKeys.length === 0) {
      adsWithoutPackages += 1;
      return {
        newPackages: [],
        isDuplicateAd: false,
        uniqueGamesFound: uniquePackageKeys.size
      };
    }

    const newPackages = packageKeys.filter(pkg => !uniquePackageKeys.has(pkg));
    if (newPackages.length === 0) duplicateAds += 1;
    for (const pkg of newPackages) uniquePackageKeys.add(pkg);

    return {
      newPackages,
      isDuplicateAd: newPackages.length === 0,
      uniqueGamesFound: uniquePackageKeys.size
    };
  }

  function getSnapshot() {
    return {
      targetUniqueGames,
      uniqueGamesFound: uniquePackageKeys.size,
      adsInspected,
      duplicateAds,
      adsWithoutPackages,
      maxAdsToInspect
    };
  }

  return {
    markInspected,
    recordPackages,
    getSnapshot,
    hasReachedTarget: () => uniquePackageKeys.size >= targetUniqueGames
  };
}

module.exports = {
  DEFAULT_MAX_ADS_PER_SCAN,
  HARD_MAX_ADS_PER_SCAN,
  resolveTargetUniqueGames,
  resolveMaxAdsToInspect,
  createScanAccounting
};
