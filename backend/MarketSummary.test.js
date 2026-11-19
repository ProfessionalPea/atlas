const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveGameClassification,
  deduplicateGames,
  detectTitleTrends,
  analyzeDataset
} = require('./MarketSummary');

function makeRow(overrides = {}) {
  const idx = overrides._idx || 1;
  return {
    id: overrides.id ?? idx,
    package_name: overrides.package_name ?? `com.studio.app${idx}`,
    title: overrides.title ?? `Sample Title ${idx}`,
    category: overrides.category ?? 'Game',
    subcategories: overrides.subcategories ?? ['Single player', 'Simulation', 'Stylized'],
    rating: overrides.rating ?? 4.2,
    ratings_count: overrides.ratings_count ?? 120,
    icon: null,
    installs: '10,000+',
    min_installs: 10000,
    real_installs: overrides.real_installs ?? 15000,
    installs_delta_1d: overrides.installs_delta_1d ?? 500,
    installs_avg_daily_7d: overrides.installs_avg_daily_7d ?? 500,
    installs_total_7d: 3500,
    released: overrides.released ?? '2026-11-10',
    release_date: overrides.release_date ?? '2026-11-10',
    first_seen_at: overrides.first_seen_at ?? '2026-11-12T10:00:00Z',
    first_campaign_seen_at: null,
    developer_id: 'dev-1',
    developer_name: 'Sample Dev',
    is_paid: false,
    price: null,
    price_text: 'Free',
    price_status: 'FREE',
    manual_price_status: null,
    release_status: 'LIVE',
    is_suspended: false,
    suspended_at: null,
    campaign_active: Boolean(overrides.campaign_active),
    campaign_source: null,
    ad_count: overrides.ad_count ?? 0,
    publisher_id: overrides.publisher_id ?? 100 + idx,
    publisher_name: overrides.publisher_name ?? `Publisher ${idx}`,
    publisher_display_name: overrides.publisher_display_name ?? `Publisher ${idx}`,
    list_id: overrides.list_id ?? idx,
    list_name: overrides.list_name ?? `Competitor ${idx}`,
    competitor_id: overrides.competitor_id ?? 10 + idx,
    group_id: overrides.group_id ?? null
  };
}

const FIXED_NOW = new Date('2026-11-19T12:00:00Z');

test('1. resolves primaryGenre, filters attribute tags, and separates games from apps', () => {
  const simGame = resolveGameClassification({
    category: 'Game',
    subcategories: ['Single player', 'Simulation', 'Stylized', 'Tycoon']
  });
  assert.equal(simGame.primaryGenre, 'Simulation');
  assert.deepEqual(simGame.subGenres, ['Tycoon']);
  assert.equal(simGame.appType, 'game');

  const toolApp = resolveGameClassification({
    category: 'Tools',
    subcategories: ['Offline']
  });
  assert.equal(toolApp.primaryGenre, 'Tools');
  assert.equal(toolApp.appType, 'app');
});

test('2. deduplicates packages appearing across multiple competitor lists without double-counting', () => {
  const rows = [
    makeRow({
      id: 1,
      package_name: 'com.shared.hit',
      title: 'Shared Mega Hit',
      publisher_id: 201,
      publisher_display_name: 'Shared Pub',
      competitor_id: 11,
      list_id: 1,
      list_name: 'Studio Alpha'
    }),
    makeRow({
      id: 1,
      package_name: 'com.shared.hit',
      title: 'Shared Mega Hit',
      publisher_id: 201,
      publisher_display_name: 'Shared Pub',
      competitor_id: 12,
      list_id: 2,
      list_name: 'Studio Beta'
    })
  ];

  const deduped = deduplicateGames(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].competitor_names.length, 2);
  assert.deepEqual(deduped[0].competitor_names.sort(), ['Studio Alpha', 'Studio Beta']);

  const summary = analyzeDataset({
    rows,
    historyRows: [],
    coverageRow: { total_days: 5, min_dt: '2026-11-14', max_dt: '2026-11-19', cur_days_covered: 5, prev_days_covered: 0 },
    options: { window: '30d', now: FIXED_NOW }
  });
  assert.equal(summary.meta.trackedCatalogCount, 1);
  assert.equal(summary.kpis.newReleasesCount, 1);
  const simGenre = summary.genreGrowth.primary.find((g) => g.genre === 'Simulation');
  assert.equal(simGenre.trackedGamesCount, 1);
});

test('3. detects "Gugu Gaga" multi-competitor new wave, collapses sub-terms, and tracks 7d vs prior 7d counts', () => {
  const rows = [
    makeRow({
      _idx: 1,
      package_name: 'com.c1.gugu',
      title: 'Gugu Gaga Brainrot Escape',
      release_date: '2026-11-18', // within last 7d (2026-11-13..2026-11-19)
      competitor_id: 1,
      list_id: 1,
      list_name: 'Comp One'
    }),
    makeRow({
      _idx: 2,
      package_name: 'com.c2.gugu',
      title: 'Gugu Gaga Meme Run',
      release_date: '2026-11-16', // within last 7d
      competitor_id: 2,
      list_id: 2,
      list_name: 'Comp Two'
    }),
    makeRow({
      _idx: 3,
      package_name: 'com.c3.gugu',
      title: 'Gugu Gaga Obby Survival',
      release_date: '2026-11-14', // within last 7d
      competitor_id: 3,
      list_id: 3,
      list_name: 'Comp Three'
    }),
    makeRow({
      _idx: 4,
      package_name: 'com.c4.gugu',
      title: 'Scary Gugu Gaga Horror',
      release_date: '2026-11-08', // within prev 7d (2026-11-06..2026-11-12)
      competitor_id: 4,
      list_id: 4,
      list_name: 'Comp Four'
    })
  ];

  const deduped = deduplicateGames(rows);
  const trends = detectTitleTrends({
    games: deduped,
    windowDays: 30,
    dateBasis: 'release_date',
    now: FIXED_NOW
  });

  const guguGaga = trends.emerging.find((t) => t.phrase === 'gugu gaga');
  assert.ok(guguGaga, 'Expected "gugu gaga" to be detected in emerging trends');
  assert.equal(guguGaga.status, 'new_wave');
  assert.equal(guguGaga.distinctCompetitors, 4);
  assert.equal(guguGaga.matchingGamesCount, 4);
  assert.equal(guguGaga.baselineGamesCount, 0);
  assert.equal(guguGaga.last7dCount, 3);
  assert.equal(guguGaga.prev7dCount, 1);

  assert.equal(
    trends.emerging.some((t) => t.phrase === 'gugu' || t.phrase === 'gaga'),
    false,
    'Expected single sub-terms "gugu" and "gaga" to be collapsed under "gugu gaga"'
  );
});

test('4. isolates single-competitor repetitive clusters out of multi-competitor emerging/repeated lists', () => {
  const rows = [];
  for (let i = 1; i <= 6; i += 1) {
    rows.push(
      makeRow({
        _idx: i,
        package_name: `com.spammer.klingon${i}`,
        title: `Zorblax Quest Edition ${i}`,
        release_date: `2026-11-${String(10 + i).padStart(2, '0')}`,
        competitor_id: 99,
        list_id: 99,
        list_name: 'Solo Spammer Studio',
        publisher_id: 900 + i,
        publisher_display_name: `Spammer Pub ${i}`
      })
    );
  }

  const deduped = deduplicateGames(rows);
  const trends = detectTitleTrends({
    games: deduped,
    windowDays: 30,
    dateBasis: 'release_date',
    now: FIXED_NOW
  });

  assert.equal(trends.emerging.some((t) => t.phrase.includes('zorblax')), false);
  assert.equal(trends.repeated.some((t) => t.phrase.includes('zorblax')), false);
  const solo = trends.singleCompetitor.find((t) => t.phrase.includes('zorblax'));
  assert.ok(solo, 'Expected solo cluster to land in singleCompetitor');
  assert.equal(solo.distinctCompetitors, 1);
  assert.equal(solo.status, 'single_competitor');
});

test('5. reports separate genre metrics, detects declining genres, and refuses fake % on insufficient coverage', () => {
  const rows = [
    // Growing Casual titles
    makeRow({
      _idx: 1,
      package_name: 'com.casual.one',
      title: 'Casual One',
      subcategories: ['Casual'],
      release_date: '2026-11-12',
      real_installs: 250000
    }),
    makeRow({
      _idx: 2,
      package_name: 'com.casual.two',
      title: 'Casual Two',
      subcategories: ['Casual'],
      release_date: '2026-11-13',
      real_installs: 120000
    }),
    makeRow({
      _idx: 3,
      package_name: 'com.casual.three',
      title: 'Casual Three',
      subcategories: ['Casual'],
      release_date: '2026-11-14',
      real_installs: 80000
    }),
    // Declining Puzzle titles (curDailyRate much lower than prevDailyRate across >= 2 matched baseline titles)
    makeRow({
      _idx: 4,
      package_name: 'com.puzzle.dec1',
      title: 'Puzzle Fade One',
      subcategories: ['Puzzle'],
      release_date: '2026-08-01',
      real_installs: 50000
    }),
    makeRow({
      _idx: 5,
      package_name: 'com.puzzle.dec2',
      title: 'Puzzle Fade Two',
      subcategories: ['Puzzle'],
      release_date: '2026-08-05',
      real_installs: 40000
    }),
    makeRow({
      _idx: 6,
      package_name: 'com.puzzle.dec3',
      title: 'Puzzle Fade Three',
      subcategories: ['Puzzle'],
      release_date: '2026-08-10',
      real_installs: 30000
    })
  ];

  // Add enough matched titles across catalog to establish 'full' baseline (>= 10 matched)
  for (let i = 1; i <= 8; i += 1) {
    rows.push(
      makeRow({
        _idx: 20 + i,
        package_name: `com.arcade.base${i}`,
        title: `Arcade Anchor ${i}`,
        subcategories: ['Arcade'],
        release_date: '2026-07-01',
        real_installs: 100000
      })
    );
  }

  const historyRows = [
    // Casual gains: 1000/day, 500/day, 200/day -> median 500/day, total +10200
    { package_name: 'com.casual.one', cur_days: 5, cur_first_installs: 244000, cur_last_installs: 250000, cur_span_days: 6, prev_days: 5, prev_first_installs: 100000, prev_last_installs: 101200, prev_span_days: 6 },
    { package_name: 'com.casual.two', cur_days: 5, cur_first_installs: 117000, cur_last_installs: 120000, cur_span_days: 6, prev_days: 5, prev_first_installs: 50000, prev_last_installs: 50600, prev_span_days: 6 },
    { package_name: 'com.casual.three', cur_days: 5, cur_first_installs: 78800, cur_last_installs: 80000, cur_span_days: 6, prev_days: 5, prev_first_installs: 20000, prev_last_installs: 20300, prev_span_days: 6 },
    // Puzzle drop: prev ~1000/day -> cur ~100/day (-90%)
    { package_name: 'com.puzzle.dec1', cur_days: 5, cur_first_installs: 49400, cur_last_installs: 50000, cur_span_days: 6, prev_days: 5, prev_first_installs: 40000, prev_last_installs: 46000, prev_span_days: 6 },
    { package_name: 'com.puzzle.dec2', cur_days: 5, cur_first_installs: 39400, cur_last_installs: 40000, cur_span_days: 6, prev_days: 5, prev_first_installs: 30000, prev_last_installs: 36000, prev_span_days: 6 },
    { package_name: 'com.puzzle.dec3', cur_days: 5, cur_first_installs: 29400, cur_last_installs: 30000, cur_span_days: 6, prev_days: 5, prev_first_installs: 20000, prev_last_installs: 26000, prev_span_days: 6 },
    ...Array.from({ length: 8 }, (_, k) => ({
      package_name: `com.arcade.base${k + 1}`,
      cur_days: 5,
      cur_first_installs: 99000,
      cur_last_installs: 100000,
      cur_span_days: 5,
      prev_days: 5,
      prev_first_installs: 98000,
      prev_last_installs: 99000,
      prev_span_days: 5
    }))
  ];

  // Full coverage run -> verifies separate metrics & declining signal
  const fullSummary = analyzeDataset({
    rows,
    historyRows,
    coverageRow: { total_days: 40, min_dt: '2026-10-01', max_dt: '2026-11-19', cur_days_covered: 20, prev_days_covered: 20 },
    options: { window: '30d', now: FIXED_NOW }
  });
  assert.equal(fullSummary.meta.coverage.comparisonStatus, 'full');

  const casual = fullSummary.genreGrowth.primary.find((g) => g.genre === 'Casual');
  assert.equal(casual.totalInstallGrowth, 10200);
  assert.equal(casual.medianDailyGrowthPerGame, 500);
  assert.equal(casual.growingGamesCount, 3);
  assert.equal(casual.decliningGamesCount, 0);

  const puzzle = fullSummary.genreGrowth.primary.find((g) => g.genre === 'Puzzle');
  assert.equal(puzzle.signal, 'declining');
  assert.equal(puzzle.decliningGamesCount, 3);
  assert.ok(puzzle.velocityChangePct <= -15);

  // Insufficient prior window coverage -> MUST NOT fabricate velocityChangePct
  const insufficientSummary = analyzeDataset({
    rows,
    historyRows: historyRows.slice(0, 6), // < 10 matched
    coverageRow: { total_days: 22, min_dt: '2026-10-19', max_dt: '2026-11-19', cur_days_covered: 20, prev_days_covered: 2 },
    options: { window: '30d', now: FIXED_NOW }
  });
  assert.equal(insufficientSummary.meta.coverage.comparisonStatus, 'insufficient');
  assert.equal(insufficientSummary.kpis.installVelocityDeltaPct, null);
  const insufficientCasual = insufficientSummary.genreGrowth.primary.find((g) => g.genre === 'Casual');
  assert.equal(insufficientCasual.velocityChangePct, null);
});

test('6. detects cross-category competitor strategy shifts with supporting evidenceGames', () => {
  const rows = [];
  // 6 historical games from Playmax (100% games historically)
  for (let i = 1; i <= 6; i += 1) {
    rows.push(
      makeRow({
        _idx: i,
        package_name: `com.playmax.histgame${i}`,
        title: `Historical Racing ${i}`,
        category: 'Game',
        subcategories: ['Racing'],
        release_date: '2026-08-01',
        competitor_id: 50,
        list_id: 50,
        list_name: 'Playmax',
        publisher_id: 500,
        publisher_display_name: 'Playmax Games'
      })
    );
  }
  // 2 recent utility apps from Playmax
  rows.push(
    makeRow({
      _idx: 7,
      package_name: 'com.playmax.cleaner',
      title: 'Phone Cleaner Pro',
      category: 'Tools',
      subcategories: ['Tools'],
      release_date: '2026-11-12',
      competitor_id: 50,
      list_id: 50,
      list_name: 'Playmax',
      publisher_id: 501,
      publisher_display_name: 'Playmax Utilities'
    }),
    makeRow({
      _idx: 8,
      package_name: 'com.playmax.scanner',
      title: 'Document Scanner Fast',
      category: 'Productivity',
      subcategories: ['Productivity'],
      release_date: '2026-11-15',
      competitor_id: 50,
      list_id: 50,
      list_name: 'Playmax',
      publisher_id: 501,
      publisher_display_name: 'Playmax Utilities'
    })
  );

  const summary = analyzeDataset({
    rows,
    historyRows: [],
    coverageRow: { total_days: 5, min_dt: '2026-11-14', max_dt: '2026-11-19', cur_days_covered: 5, prev_days_covered: 0 },
    options: { window: '30d', now: FIXED_NOW }
  });

  const pivot = summary.competitorActivity.strategyShifts.find(
    (s) => s.competitorName === 'Playmax' && s.type === 'cross_category'
  );
  assert.ok(pivot, 'Expected cross_category strategy shift for Playmax');
  assert.equal(pivot.count, 2);
  assert.equal(pivot.evidenceGames.length, 2);
  assert.deepEqual(
    pivot.evidenceGames.map((g) => g.package_name).sort(),
    ['com.playmax.cleaner', 'com.playmax.scanner']
  );
});

test('7. strictly separates Play Store release_date vs Atlas discovery date (first_seen_at)', () => {
  const rows = [
    makeRow({
      _idx: 1,
      package_name: 'com.oldlaunch.newfind',
      title: 'Old Launch Discovered Today',
      release_date: '2026-07-01', // ~141d before FIXED_NOW
      released: '2026-07-01',
      first_seen_at: '2026-11-16T12:00:00Z' // 3d ago
    }),
    makeRow({
      _idx: 2,
      package_name: 'com.newlaunch.newfind',
      title: 'Fresh Launch This Week',
      release_date: '2026-11-15', // 4d ago
      released: '2026-11-15',
      first_seen_at: '2026-11-16T12:00:00Z'
    })
  ];

  const byRelease = analyzeDataset({
    rows,
    historyRows: [],
    coverageRow: null,
    options: { window: '14d', dateBasis: 'release_date', now: FIXED_NOW }
  });
  assert.equal(byRelease.kpis.newReleasesCount, 1);
  assert.deepEqual(
    byRelease.recentTitles.map((g) => g.package_name),
    ['com.newlaunch.newfind']
  );

  const byDiscovered = analyzeDataset({
    rows,
    historyRows: [],
    coverageRow: null,
    options: { window: '14d', dateBasis: 'first_seen_at', now: FIXED_NOW }
  });
  assert.equal(byDiscovered.kpis.newReleasesCount, 2);
  assert.deepEqual(
    byDiscovered.recentTitles.map((g) => g.package_name).sort(),
    ['com.newlaunch.newfind', 'com.oldlaunch.newfind']
  );
});
