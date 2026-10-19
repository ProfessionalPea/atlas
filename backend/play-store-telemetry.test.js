const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializePlayTelemetryStorage,
  fetchPlayStoreDs5,
  computeVelocityMetrics,
  parseAppAdsTxtContent,
  selectPrimaryStudioSeller,
  computeEngagementAndRevenue,
  runFullTelemetryForPackage
} = require('./PlayStoreTelemetry');

// Lightweight in-memory mock pool that mimics PostgreSQL for end-to-end verification
function createMockTelemetryPool() {
  const games = new Map();
  const installHistory = new Map(); // key: `${pkg}:${date}` -> { package_name, snapshot_date, real_installs, daily_delta }
  const sellersCache = new Map();

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

      if (/SELECT developer_website, developer_name FROM games WHERE package_name = \$1/i.test(normalized)) {
        const g = games.get(params[0]);
        return { rows: g ? [g] : [] };
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
        g.advertiser_legal_name = params[3] || g.advertiser_legal_name;
        g.developer_name = params[4] || g.developer_name;
        g.developer_website = params[5] || g.developer_website;
        g.networks_scanned_at = new Date().toISOString();
        games.set(pkg, g);
        return { rows: [] };
      }

      if (/UPDATE games\s+SET card_status/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg) || { id: nextGameId++, package_name: pkg };
        g.card_status = params[1];
        g.card_scanned_at = new Date().toISOString();
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

      if (/SELECT g\.\*,\s+COALESCE/i.test(normalized)) {
        const pkg = params[0];
        const g = games.get(pkg);
        if (!g) return { rows: [] };
        const hist = [...installHistory.values()]
          .filter(r => r.package_name === pkg)
          .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
          .slice(-14)
          .map(r => ({
            date: r.snapshot_date,
            realInstalls: r.real_installs,
            dailyDelta: r.daily_delta
          }));
        return { rows: [{ ...g, install_history: hist }] };
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

test('Step 7 End-to-End Acceptance Test: com.res.happy.days.adventure resolves ds:5 installs, Admob 100%, THE GAME STORM STUDIOS (PVT.) LIMITED, and card_status', async () => {
  const pool = createMockTelemetryPool();
  await initializePlayTelemetryStorage(pool);
  assert.equal(pool.ddlExecuted.length, 1, 'Schema migration DDL executed');

  const pkg = 'com.res.happy.days.adventure';
  const result = await runFullTelemetryForPackage(pool, pkg);
  const game = result.game;

  assert.ok(game, 'Game record returned');
  assert.equal(game.package_name, pkg);
  assert.equal(game.installs_tier, '100,000+');
  assert.ok(Number(game.real_installs) > 100000, `real_installs (${game.real_installs}) should be exact unrounded integer > 100,000`);
  assert.ok(Array.isArray(game.install_history) && game.install_history.length >= 2, 'app_install_history populated for sparkline');

  assert.deepEqual(game.ad_networks, { Admob: 100 }, 'ad_networks resolves to Admob: 100%');
  assert.equal(
    game.advertiser_legal_name,
    'THE GAME STORM STUDIOS (PVT.) LIMITED',
    'advertiser_legal_name resolves to THE GAME STORM STUDIOS (PVT.) LIMITED'
  );
  assert.equal(game.developer_name, 'Respawn Tech Games');
  assert.equal(game.card_status, 'closed');
  assert.ok(Array.isArray(game.subcategories) && game.subcategories.includes('Simulation'));
  assert.ok(game.store_scanned_at);
  assert.ok(game.installs_scanned_at);
  assert.ok(game.networks_scanned_at);
  assert.ok(game.card_scanned_at);

  console.log('Verified com.res.happy.days.adventure telemetry:', {
    title: game.title,
    installs_tier: game.installs_tier,
    real_installs: game.real_installs,
    installs_delta_1d: game.installs_delta_1d,
    installs_avg_daily_7d: game.installs_avg_daily_7d,
    installs_total_7d: game.installs_total_7d,
    estimated_dau: game.estimated_dau,
    retention_d1: game.retention_d1,
    retention_d7: game.retention_d7,
    avg_session_minutes: game.avg_session_minutes,
    rev_monthly_min: game.rev_monthly_min,
    rev_monthly_max: game.rev_monthly_max,
    rev_confidence: game.rev_confidence,
    subcategories: game.subcategories,
    release_date: game.release_date,
    card_status: game.card_status,
    ad_networks: game.ad_networks,
    developer_name: game.developer_name,
    advertiser_legal_name: game.advertiser_legal_name,
    sparkline_points: game.install_history.length
  });
});
