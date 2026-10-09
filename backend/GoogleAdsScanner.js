// Atlas scanner entry point.
//
// Package discovery deliberately follows the broad September model: the scan
// limit caps creatives inspected, not games discovered. A single creative may
// contribute multiple package names. Modern Atlas services stay loaded through
// AtlasExtensions, while video ownership remains strict inside the broad scanner.
const { extensionPool } = require('./AtlasExtensions');
const broadScanner = require('./GoogleAdsScannerBroad');

async function clearExtractionCache() {
  try {
    // v4/v5/v6 caches were built around stricter/single-owner extraction and can
    // suppress the broad results we are intentionally restoring. Fresh creative
    // inspection is preferred while this discovery model is active.
    const result = await extensionPool.query('DELETE FROM creative_extraction_cache');
    if (result.rowCount > 0) {
      console.log(`♻️ [Broad Scanner] Cleared ${result.rowCount} cached creative extraction${result.rowCount === 1 ? '' : 's'} before fresh discovery.`);
    }
  } catch (error) {
    console.warn('♻️ [Broad Scanner] Cache clear skipped:', error.message);
  }
}

async function scanCompetitor(...args) {
  await clearExtractionCache();

  console.log('📦 [Scanner] September-style broad multi-package discovery is active.');
  const results = await broadScanner.scanCompetitor(...args);
  const safeResults = Array.isArray(results) ? results : [];
  const packages = new Set(
    safeResults
      .map(entry => String(entry?.package || '').trim().toLowerCase())
      .filter(Boolean)
  );

  console.log(
    `📦 [Scanner] Returned ${packages.size} unique package${packages.size === 1 ? '' : 's'} ` +
    `across ${safeResults.length} creative/package mapping${safeResults.length === 1 ? '' : 's'}.`
  );

  return safeResults;
}

module.exports = {
  ...broadScanner,
  scanCompetitor
};
