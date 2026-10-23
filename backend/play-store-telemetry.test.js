const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializePlayTelemetryStorage,
  fetchPlayStoreDs5,
  computeVelocityMetrics,
  parseAppAdsTxtContent,
  selectPrimaryStudioSeller,
  computeEngagementAndRevenue,
  evaluateCardStatusFromAdSignals,
  runCardStatusPipeline,
  runFullTelemetryForPackage
} = require('./PlayStoreTelemetry');

// Lightweight in-memory mock pool that mimics PostgreSQL for end-to-end verification
function createMockTelemetryPool() {
  const games = new Map();
  const installHistory = new Map(); // key: `${pkg}:${date}` -> { package_name, snapshot_date, real_installs, daily_delta }
  const sellersCache = new Map();
  const adCreatives = []; // { creative_id, game_id, package_name, last_seen_at }
  const accountGames = new Set(); // game_id

  // Pre-seed sellers.json cache with the verified sellers from Google's public sellers.json for com.res.happy.days.adventure
  // so tests run deterministically in <2s without re-streaming 107MB over the network every test run
  const seededSellers = [
    { seller_id: 'pub-3872674820285626', seller_type: 'BOTH', name: 'RTB DEMAND PTE. LTD.', domain: 'rtbdemand.com', is_confidential: false },
    { seller_id: 'pub-4586415728471297', seller_type: 'BOTH', name: 'Playstream', domain: 'playstream.media', is_confidential: false },
    { seller_id: 'pub-4613823032840158', seller_type: 'PUBLISHER', name: 'UndrAds Innovation Technologies L.L.C.- FZ', domain: 'undrads.com', is_confidential: false },
    { seller_id: 'pub-7328148952369365', seller_type: 'PUBLISHER', name: null, domain: null, is_confidential: true },
    { seller_id: 'pub-7526285253397422', seller_type: 'BOTH', name: 'UndrAds Innovation technologies LLC FZ', domain: 'undrads.com', is_confidential: false },
    { seller_id: 'pub-7850771599993172', seller_type: 'PUBLISHER', name: 'The Game Storm Studios Pvt Ltd', domain: null, is_confidential: false },
    { seller_id: 'pub-8584156348842922', seller_type: 'BOTH', name: 'ADSOLUT TECHNOLOGY SERVICES L.L.C', domain: 'adsolut.in', is_confidential: false },
    { seller_id: 'pub-8766006423657606', seller_type: 'PUBLISHER', name: null, domain: null, is_confidential: true }
  ];
  for (const s of seededSellers) sellersCache.set(s.seller_id.toLowerCase(), s);

  let nextGameId = 1;
  const ddlExecuted = [];

  return {
    ddlExecuted,
    games,
    installHistory,
    sellersCache,
    adCreatives,
    accountGames,
    async query(sql, params = []) {
      const normalized = String(sql).trim();

      if (/ALTER TABLE games|CREATE TABLE IF NOT EXISTS app_install_history/i.test(normalized)) {
        ddlExecuted.push(normalized);
        return { rows: [] };
      }

      if (/SELECT id FROM games WHERE package_name = \$1/i.test(normalized)) {
        const g = games.get(params[0]);
        return { rows: g ? [{ id: g.id }] : [] };
      }

      if (/SELECT id, released, release_date FROM games WHERE package_name = \$1/i.test(normalized)) {
        const g = games.get(params[0]);
        return { rows: g ? [g] : [] };
      }

      if (/SELECT developer_website, developer_name, ad_networks, ad_networks_all, network_data, advertiser_legal_name, networks_scanned_at\s+FROM games WHERE package_name = \$1/i.test(normalized)) {
        const g = games.get(params[0]);
        return { rows: g ? [g] : [] };
      }

      if (/SELECT g\.id, g\.ad_count,\s+EXISTS/i.test(normalized)) {
        const g = games.get(params[0]);
        if (!g) return { rows: [] };
        return {
          rows: [{
            id: g.id,
            ad_count: g.ad_count ?? 0,
            has_competitor_link: accountGames.has(g.id)
          }]
        };
      }

      if (/SELECT MAX\(last_seen_at\) AS latest_creative_seen, COUNT\(\*\)::int AS total_creatives\s+FROM ad_creatives/i.test(normalized)) {
        const pkg = params[0];
        const gameId = params[1];
        const matching = adCreatives.filter(
          c => c.package_name === pkg || (gameId != null && c.game_id === gameId)
        );
        if (matching.length === 0) {
          return { rows: [{ latest_creative_seen: null, total_creatives: 0 }] };
        }
        const latest = matching
          .map(c => new Date(c.last_seen_at).getTime())
          .reduce((a, b) => Math.max(a, b), 0);
        return {
          rows: [{
            latest_creative_seen: new Date(latest).toISOString(),
            total_creatives: matching.length
          }]
        };
      }

      if (/SELECT real_installs, installs_delta_1d, installs_avg_daily_7d, subcategories, release_date, released\s+FROM games/i.test(normalized)) {
        const g = games.get(params[0]);
        return { rows: g ? [g] : [] };
      }

      if (/INSERT INTO games/i.test(normalized)) {
        const pkg = params[0];
        const existing = games.get(pkg) || { id: nextGameId++ };
        const record = {
          ...existing,
          package_name: pkg,
          title: params[1],
          category: params[2],
          rating: params[3],
          ratings_count: params[4],
          icon: params[5],
          description: params[6],
          installs: params[7],
          min_installs: params[8],
          released: params[9],
          header_image: params[10]
        };
        games.set(pkg, record);
        return { rows: [{ id: record.id }] };
      }

      if (/SELECT snapshot_date::text AS snapshot_date, real_installs, daily_delta\s+FROM app_install_history/i.test(normalized)) {
        const pkg = params[0];
        const desc = /ORDER BY snapshot_date DESC/i.test(normalized);
        const rows = [...installHistory.values()]
          .filter(r => r.package_name === pkg)
          .sort((a, b) => desc ? b.snapshot_date.localeCompare(a.snapshot_date) : a.snapshot_date.localeCompare(b.snapshot_date));
        return { rows };
      }

      if (/INSERT INTO app_install_history/i.test(normalized)) {
        const pkg = params[0];
        let dateStr;
        let realInstalls;
        let dailyDelta;
        if (normalized.includes("INTERVAL '1 day'")) {
          const daysAgo = Number(params[1]) || 0;
          dateStr = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
          realInstalls = Number(params[2]);
          dailyDelta = Number(params[3]);
          const key = `${pkg}:${dateStr}`;
          if (!installHistory.has(key)) {
            installHistory.set(key, { package_name: pkg, snapshot_date: dateStr, real_installs: realInstalls, daily_delta: dailyDelta });
          }
        } else {
          dateStr = new Date().toISOString().slice(0, 10);
          realInstalls = Number(params[1]);
          dailyDelta = Number(params[2]);
          const key = `${pkg}:${dateStr}`;
          installHistory.set(key, { package_name: pkg, snapshot_date: dateStr, real_installs: realInstalls, daily_delta: dailyDelta });
        }
        return { rows: [] };
      }

      if (/UPDATE games\s+SET installs_tier/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg) || { id: nextGameId++, package_name: pkg };
        g.installs_tier = params[1] || g.installs_tier || g.installs;
        g.installs = params[1] || g.installs;
        g.real_installs = params[2];
        g.installs_delta_1d = params[3];
        g.installs_avg_daily_7d = params[4];
        g.installs_total_7d = params[5];
        g.subcategories = JSON.parse(params[6] || '[]');
        g.release_date = params[7] || g.release_date;
        g.developer_name = params[8] || g.developer_name;
        g.developer_website = params[9] || g.developer_website;
        g.store_scanned_at = new Date().toISOString();
        g.installs_scanned_at = new Date().toISOString();
        games.set(pkg, g);
        return { rows: [] };
      }

      if (/SELECT seller_id, name, domain, seller_type, is_confidential, updated_at\s+FROM google_sellers_cache/i.test(normalized)) {
        const ids = params[0] || [];
        const rows = ids
          .map(id => sellersCache.get(String(id).toLowerCase()))
          .filter(Boolean);
        return { rows };
      }

      if (/UPDATE games\s+SET ad_networks/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg) || { id: nextGameId++, package_name: pkg };
        g.ad_networks = JSON.parse(params[1] || '{}');
        g.ad_networks_all = JSON.parse(params[2] || '{}');
        g.network_data = JSON.parse(params[3] || '{}');
        g.advertiser_legal_name = params[4] || g.advertiser_legal_name;
        g.developer_name = params[5] || g.developer_name;
        g.developer_website = params[6] || g.developer_website;
        g.networks_scanned_at = new Date().toISOString();
        games.set(pkg, g);
        return { rows: [] };
      }

      if (/UPDATE games\s+SET card_status/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg) || { id: nextGameId++, package_name: pkg };
        g.card_status = params[1];
        g.card_scanned_at = params[2] || new Date().toISOString();
        games.set(pkg, g);
        return { rows: [] };
      }

      if (/UPDATE games\s+SET estimated_dau/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg) || { id: nextGameId++, package_name: pkg };
        g.estimated_dau = params[1];
        g.retention_d1 = params[2];
        g.retention_d7 = params[3];
        g.avg_session_minutes = params[4];
        g.rev_monthly_min = params[5];
        g.rev_monthly_max = params[6];
        g.rev_confidence = params[7];
        games.set(pkg, g);
        return { rows: [] };
      }

      if (/SELECT g\.\*,\s+\(SELECT MAX\(ac\.last_seen_at\)/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg);
        if (!g) return { rows: [] };
        const matching = adCreatives.filter(
          c => c.package_name === pkg || c.game_id === g.id
        );
        const latestCreativeSeen = matching.length > 0
          ? new Date(Math.max(...matching.map(c => new Date(c.last_seen_at).getTime()))).toISOString()
          : null;
        const hist = [...installHistory.values()]
          .filter(r => r.package_name === pkg)
          .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
          .slice(-14)
          .map(r => ({
            date: r.snapshot_date,
            realInstalls: r.real_installs,
            dailyDelta: r.daily_delta
          }));
        return { rows: [{ ...g, latest_creative_seen: latestCreativeSeen, install_history: hist }] };
      }

      return { rows: [] };
    }
  };
}

test('Step 5 sanity check formula: 3,200 DAU at 10m/day outputs $40-$362/mo with ~low conf', () => {
  const result = computeEngagementAndRevenue({
    subcategories: ['Simulation', 'Pet Care'],
    historyRows: [],
    realInstalls: 284170,
    installsDelta1d: 35500,
    installsAvgDaily7d: 27700,
    releaseDate: '2026-08-18',
    panelData: {
      estimatedDau: 3200,
      retentionD1: 23,
      retentionD7: 4,
      avgSessionMinutes: 10
    }
  });

  assert.equal(result.estimatedDau, 3200);
  assert.equal(result.retentionD1, 23);
  assert.equal(result.retentionD7, 4);
  assert.equal(result.avgSessionMinutes, 10);
  assert.equal(result.revMonthlyMin, 40);
  assert.equal(result.revMonthlyMax, 362);
  assert.equal(result.revConfidence, 'low');
});

test('Task 1 & 2 Verification across 3 Distinct Game Scenarios (Active <48h, Stale >14d, Multi-Network AppLovin/AdMob)', async () => {
  const pool = createMockTelemetryPool();
  await initializePlayTelemetryStorage(pool);
  assert.equal(pool.ddlExecuted.length, 1, 'Schema migration DDL executed');

  // -------------------------------------------------------------------------
  // Game 1: Active ads scanned in the last 48 hours + Multi-network app-ads.txt
  // (com.res.happy.days.adventure has Admob, Mintegral, AppLovin, Unity Ads, Liftoff, Chartboost, InMobi, Meta, ironSource)
  // -------------------------------------------------------------------------
  const pkgActiveMulti = 'com.res.happy.days.adventure';
  const fortyEightHoursAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  pool.adCreatives.push({
    creative_id: 'CR-ACTIVE-001',
    game_id: 1,
    package_name: pkgActiveMulti,
    last_seen_at: fortyEightHoursAgoIso
  });

  const res1 = await runFullTelemetryForPackage(pool, pkgActiveMulti);
  const game1 = res1.game;

  assert.ok(game1, 'Game 1 record returned');
  assert.equal(game1.card_status, 'active', 'Game 1 with ads in last 48h MUST be card_status = active (🟢 Card Active)');
  assert.equal(game1.latest_creative_seen, fortyEightHoursAgoIso, 'Footer Card date synced with latest_creative_seen');

  // Verify Game 1 does NOT show hardcoded { Admob: 100 } — it has multiple verified networks in app-ads.txt
  const netKeys1 = Object.keys(game1.ad_networks);
  assert.ok(netKeys1.length > 1, `Expected multi-network share map, got: ${JSON.stringify(game1.ad_networks)}`);
  assert.notDeepEqual(game1.ad_networks, { Admob: 100 }, 'Multi-network game must NOT show hardcoded Admob · 100%');
  assert.ok(game1.ad_networks.Admob > 0 && game1.ad_networks.Admob < 100, 'Admob has proportional share < 100%');
  assert.ok(game1.ad_networks.AppLovin > 0, 'AppLovin share is present');
  assert.ok(game1.ad_networks.Mintegral > 0, 'Mintegral share is present');
  const shareSum1 = Object.values(game1.ad_networks).reduce((a, b) => a + b, 0);
  assert.equal(shareSum1, 100, 'Proportional network shares sum to 100%');
  assert.ok(
    /THE GAME STORM STUDIOS/i.test(game1.advertiser_legal_name || ''),
    `advertiser_legal_name (${game1.advertiser_legal_name}) resolves to THE GAME STORM STUDIOS legal entity`
  );

  // -------------------------------------------------------------------------
  // Game 2: Game whose ads stopped running >14 days ago -> MUST show Card Closed
  // -------------------------------------------------------------------------
  const pkgStale = 'com.stale.competitor.shooter';
  const twentyDaysAgoIso = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
  pool.games.set(pkgStale, {
    id: 2,
    package_name: pkgStale,
    title: 'Stale Shooter',
    ad_count: 12
  });
  pool.accountGames.add(2);
  pool.adCreatives.push({
    creative_id: 'CR-STALE-001',
    game_id: 2,
    package_name: pkgStale,
    last_seen_at: twentyDaysAgoIso
  });

  const cardRes2 = await runCardStatusPipeline(pool, pkgStale);
  assert.equal(cardRes2.cardStatus, 'closed', 'Game 2 with latest_creative_seen > 14 days ago MUST be closed (⏹ Card Closed)');
  assert.equal(cardRes2.latestCreativeSeen, twentyDaysAgoIso);

  // -------------------------------------------------------------------------
  // Game 3: AppLovin MAX dominant multi-network app-ads.txt & Unscanned fallback
  // -------------------------------------------------------------------------
  const appLovinMaxSample = [
    'applovin.com, d8921a8b90123, DIRECT, c7542',
    'applovin.com, e9921a8b90124, DIRECT, c7542',
    'applovin.com, f9921a8b90125, DIRECT, c7542',
    'google.com, pub-7850771599993172, DIRECT, f08c47fec0942fa0',
    'unity3d.com, 1234567, DIRECT'
  ].join('\n');

  const parsedMax = parseAppAdsTxtContent(appLovinMaxSample);
  assert.ok(parsedMax.adNetworks.AppLovin > parsedMax.adNetworks.Admob, 'AppLovin dominant share > Admob share');
  assert.equal(parsedMax.adNetworks.AppLovin, 60, 'AppLovin 3/5 DIRECT = 60%');
  assert.equal(parsedMax.adNetworks.Admob, 20, 'Admob 1/5 DIRECT = 20%');
  assert.equal(parsedMax.adNetworks['Unity Ads'], 20, 'Unity Ads 1/5 DIRECT = 20%');

  // Verify unscanned package (e.g., added via Country Scans without an ad scan)
  const pkgUnscanned = 'com.countryscan.only.game';
  pool.games.set(pkgUnscanned, {
    id: 3,
    package_name: pkgUnscanned,
    title: 'Country Scan Game',
    ad_count: 0
  });
  const cardRes3 = await runCardStatusPipeline(pool, pkgUnscanned);
  assert.equal(cardRes3.cardStatus, 'unscanned', 'Package without competitor ad scan defaults to unscanned (⚪ Unscanned)');

  console.log('Verified all 3 scenarios:', {
    game1_active_multi: {
      package: pkgActiveMulti,
      card_status: game1.card_status,
      latest_creative_seen: game1.latest_creative_seen,
      ad_networks: game1.ad_networks,
      advertiser_legal_name: game1.advertiser_legal_name
    },
    game2_stale_closed: cardRes2,
    game3_applovin_max: parsedMax.adNetworks,
    game3_unscanned_card: cardRes3
  });
});

