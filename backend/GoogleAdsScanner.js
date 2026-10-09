// Emergency scanner rollback.
//
// Scanner v5/v6 improved ownership strictness, but real-world advertiser scans
// regressed badly in package coverage. For the discovery product, missing real
// games is currently more damaging than the older engine's broader capture
// behavior. Keep Atlas intelligence routes loaded, but delegate ad/package
// extraction to the last broad multi-package scanner (V2).
const { extensionPool } = require('./AtlasExtensions');
const legacyScanner = require('./GoogleAdsScannerV2');

async function clearExtractionCache() {
  try {
    // Do this before every target while the rollback is active. v5/v6 cache
    // entries can contain a single canonical owner (or an incomplete package
    // list), and V2 would otherwise reuse those rows instead of re-inspecting
    // the creative. Fresh extraction is intentionally preferred over speed.
    const result = await extensionPool.query('DELETE FROM creative_extraction_cache');
    if (result.rowCount > 0) {
      console.log(`♻️ [Legacy Scanner] Cleared ${result.rowCount} cached creative extraction${result.rowCount === 1 ? '' : 's'} before fresh discovery.`);
    }
  } catch (error) {
    // Cache is only an optimization. If the intelligence tables are unavailable,
    // continue with a fresh scan rather than failing the entire job.
    console.warn('♻️ [Legacy Scanner] Cache clear skipped:', error.message);
  }
}

async function scanCompetitor(...args) {
  await clearExtractionCache();

  console.warn('⚠️ [Scanner] Emergency legacy V2 capture mode is active: prioritizing package discovery coverage over strict single-owner resolution.');
  const results = await legacyScanner.scanCompetitor(...args);

  const packages = new Set(
    (Array.isArray(results) ? results : [])
      .map(entry => String(entry?.package || '').trim().toLowerCase())
      .filter(Boolean)
  );

  console.log(
    `📦 [Legacy Scanner] Returned ${packages.size} unique package${packages.size === 1 ? '' : 's'} ` +
    `across ${Array.isArray(results) ? results.length : 0} creative/package mapping${results?.length === 1 ? '' : 's'}.`
  );

  return Array.isArray(results) ? results : [];
}

module.exports = {
  ...legacyScanner,
  scanCompetitor
};
