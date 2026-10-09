const assert = require('node:assert/strict');
const {
  beginScan,
  recordDiscoveredPackages,
  mergeScanStatus,
  getSnapshot
} = require('./ScanDiscoveryRegistry');

beginScan('scan-a');
recordDiscoveredPackages(
  ['com.alpha.game', 'ai.beta.runner', 'com.alpha.game'],
  { candidates: 3, playValidated: 1, acceptedFromStoreEvidence: 1 }
);

const merged = mergeScanStatus({
  scanId: 'scan-a',
  state: 'complete',
  packages: ['com.alpha.game']
});
assert.deepEqual(
  new Set(merged.packages),
  new Set(['com.alpha.game', 'ai.beta.runner'])
);
assert.equal(merged.discoveryStats.candidates, 3);
assert.equal(merged.discoveryStats.acceptedFromStoreEvidence, 1);

// A new scan must never inherit packages from the previous scan.
beginScan('scan-b');
recordDiscoveredPackages(['org.new.game'], { candidates: 1 });
assert.deepEqual(getSnapshot().packages, ['org.new.game']);
assert.deepEqual(mergeScanStatus({ scanId: 'scan-b', packages: [] }).packages, ['org.new.game']);

// Old/status-mismatched payloads are left untouched.
assert.deepEqual(
  mergeScanStatus({ scanId: 'scan-a', packages: ['legacy.game'] }).packages,
  ['legacy.game']
);

console.log('scan-discovery-registry tests passed');
