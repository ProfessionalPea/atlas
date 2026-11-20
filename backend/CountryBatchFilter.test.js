const test = require('node:test');
const assert = require('node:assert/strict');

const { filterCandidatesByReleaseWindow } = require('./PlayStoreIntelligence');

const NOW = new Date('2026-11-20T06:00:00Z'); // todayUtc = 2026-11-20

const SAMPLE_ROWS = [
  { package_name: 'com.today.game', title: 'Released Today', release_date: '2026-11-20' },
  { package_name: 'com.edge7.game', title: 'Day 7 Boundary', release_date: '2026-11-14' },   // today - 6d -> included in 7d
  { package_name: 'com.out7.game', title: 'Day 8 Excluded 7d', release_date: '2026-11-13' }, // today - 7d -> excluded in 7d, included in 14d
  { package_name: 'com.edge14.game', title: 'Day 14 Boundary', released: 'Nov 7, 2026' },   // fallback to `released`, today - 13d -> included in 14d
  { package_name: 'com.out14.game', title: 'Day 15 Excluded 14d', release_date: '2026-11-06' }, // included in 30d
  { package_name: 'com.edge30.game', title: 'Day 30 Boundary', release_date: '2026-10-22' }, // today - 29d -> included in 30d
  { package_name: 'com.old31.game', title: 'Day 31 Too Old', release_date: '2026-10-21' },   // excluded in 30d
  { package_name: 'com.unknown.game', title: 'Missing Date', release_date: null, released: 'Unknown' },
  { package_name: 'com.today.game', title: 'Duplicate Today', release_date: '2026-11-20' }
];

test('returns all deduplicated candidates including unknown dates when days is 0 or null', () => {
  const resZero = filterCandidatesByReleaseWindow(SAMPLE_ROWS, 0, NOW);
  assert.equal(resZero.length, 8);
  assert.deepEqual(
    resZero.map((r) => r.package_name),
    [
      'com.today.game',
      'com.edge7.game',
      'com.out7.game',
      'com.edge14.game',
      'com.out14.game',
      'com.edge30.game',
      'com.old31.game',
      'com.unknown.game'
    ]
  );

  const resNull = filterCandidatesByReleaseWindow(SAMPLE_ROWS, null, NOW);
  assert.equal(resNull.length, 8);
});

test('filters inclusively to the last 7 days', () => {
  const res = filterCandidatesByReleaseWindow(SAMPLE_ROWS, 7, NOW);
  assert.deepEqual(
    res.map((r) => r.package_name),
    ['com.today.game', 'com.edge7.game']
  );
});

test('filters inclusively to the last 14 days including text `released` dates', () => {
  const res = filterCandidatesByReleaseWindow(SAMPLE_ROWS, 14, NOW);
  assert.deepEqual(
    res.map((r) => r.package_name),
    ['com.today.game', 'com.edge7.game', 'com.out7.game', 'com.edge14.game']
  );
});

test('filters inclusively to the last 30 days and excludes missing/older dates', () => {
  const res = filterCandidatesByReleaseWindow(SAMPLE_ROWS, 30, NOW);
  assert.deepEqual(
    res.map((r) => r.package_name),
    [
      'com.today.game',
      'com.edge7.game',
      'com.out7.game',
      'com.edge14.game',
      'com.out14.game',
      'com.edge30.game'
    ]
  );
});
