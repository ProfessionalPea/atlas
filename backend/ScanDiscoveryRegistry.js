let activeScanId = null;
let discoveredPackages = new Set();
let aggregateStats = createEmptyStats();

function createEmptyStats() {
  return {
    candidates: 0,
    existing: 0,
    playValidated: 0,
    acceptedFromStoreEvidence: 0,
    rejectedMetadataOnly: 0,
    lookupCircuitOpened: false
  };
}

function beginScan(scanId) {
  activeScanId = scanId ? String(scanId) : null;
  discoveredPackages = new Set();
  aggregateStats = createEmptyStats();
}

function recordDiscoveredPackages(packages, stats = {}) {
  for (const value of packages || []) {
    const packageName = String(value || '').trim().toLowerCase();
    if (packageName) discoveredPackages.add(packageName);
  }

  for (const key of [
    'candidates',
    'existing',
    'playValidated',
    'acceptedFromStoreEvidence',
    'rejectedMetadataOnly'
  ]) {
    aggregateStats[key] += Math.max(0, Number(stats?.[key]) || 0);
  }
  aggregateStats.lookupCircuitOpened =
    aggregateStats.lookupCircuitOpened || stats?.lookupCircuitOpened === true;
}

function mergeScanStatus(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const payloadScanId = payload.scanId ? String(payload.scanId) : null;
  if (activeScanId && payloadScanId && activeScanId !== payloadScanId) return payload;

  const packages = [...new Set([
    ...(Array.isArray(payload.packages) ? payload.packages : []),
    ...discoveredPackages
  ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];

  return {
    ...payload,
    packages,
    discoveryStats: { ...aggregateStats }
  };
}

function getSnapshot() {
  return {
    scanId: activeScanId,
    packages: [...discoveredPackages],
    discoveryStats: { ...aggregateStats }
  };
}

module.exports = {
  beginScan,
  recordDiscoveredPackages,
  mergeScanStatus,
  getSnapshot
};
