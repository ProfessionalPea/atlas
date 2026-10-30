const express = require('express');
const zlib = require('zlib');
const { getDatabasePool } = require('./Security');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;
const {
  initializeIntelligenceFeatures,
  registerIntelligenceRoutes
} = require('./IntelligenceFeatures');
const {
  initializeVideoLifecycle,
  registerVideoLifecycleRoutes
} = require('./VideoLifecycle');
const {
  initializeVideoMetadata,
  registerVideoMetadataRoutes
} = require('./VideoLibraryMetadata');
const {
  beginScan,
  mergeScanStatus
} = require('./ScanDiscoveryRegistry');
const {
  initializePlayTelemetryStorage,
  registerPlayTelemetryRoutes
} = require('./PlayStoreTelemetry');
const {
  initializeAmazonStorage,
  registerAmazonRoutes
} = require('./AmazonIntelligence');
const {
  initializePlayStoreStorage,
  registerPlayStoreRoutes,
  syncLegacyAccountsAndCompetitors
} = require('./PlayStoreIntelligence');
const {
  initializeCompetitorGroupsStorage,
  registerCompetitorGroupRoutes
} = require('./CompetitorGroups');

const extensionPool = getDatabasePool();

let initialized = false;
let registered = false;

// server.js historically builds the Latest dashboard package list only from
// creatives that have one canonical owner. Scanner v6 deliberately discovers
// real secondary packages without assigning the ad to them. Because this module
// is loaded before server.js registers its Express routes, wrap just the scan
// start/status routes so the UI receives every validated discovered package
// while the legacy ad-counting loop still sees canonical results only.
const SCAN_STATUS_BRIDGE = Symbol.for('atlas.scanStatusDiscoveryBridge');
if (!express.application[SCAN_STATUS_BRIDGE]) {
  express.application[SCAN_STATUS_BRIDGE] = true;

  // Shared in-memory cache + coalesced fetcher for /api/trending, /api/competitors, and /api/stats
  // so initial parallel page loads and tab switches run a single slim query and return in <5ms.
  const directoryCache = {
    stats: null,
    trending: null,
    competitors: null,
    expiresAt: 0,
    inflight: null
  };

  function invalidateDirectoryCache() {
    directoryCache.stats = null;
    directoryCache.trending = null;
    directoryCache.competitors = null;
    directoryCache.expiresAt = 0;
  }

  async function ensureDirectoryDataLoaded() {
    if (directoryCache.trending && directoryCache.competitors && directoryCache.expiresAt > Date.now()) {
      return directoryCache;
    }
    if (directoryCache.inflight) {
      return directoryCache.inflight;
    }

    directoryCache.inflight = (async () => {
      try {
        const [compRes, accRes, gamesRes, totalGamesRes] = await Promise.all([
          extensionPool.query('SELECT * FROM competitors ORDER BY id DESC'),
          extensionPool.query('SELECT * FROM accounts'),
          extensionPool.query(`
            WITH creative_meta AS (
              SELECT
                package_name,
                MAX(last_seen_at) AS latest_creative_seen,
                COUNT(*)::int AS total_creatives
              FROM ad_creatives
              WHERE package_name IS NOT NULL
              GROUP BY package_name
            )
            SELECT
              ag.account_id,
              a.publisher_name,
              c.id AS competitor_id,
              c.name AS competitor_name,
              g.id,
              g.package_name,
              g.title,
              g.category,
              g.subcategories,
              g.rating,
              g.ratings_count,
              g.icon,
              g.installs,
              g.installs_tier,
              g.min_installs,
              g.real_installs,
              g.installs_delta_1d,
              g.installs_avg_daily_7d,
              g.installs_total_7d,
              g.estimated_dau,
              g.retention_d1,
              g.retention_d7,
              g.avg_session_minutes,
              g.rev_monthly_min,
              g.rev_monthly_max,
              g.rev_confidence,
              g.released,
              g.release_date::text AS release_date,
              g.updated,
              g.ad_count,
              g.is_paid,
              g.price,
              g.currency,
              g.price_text,
              g.is_suspended,
              g.suspended_at,
              g.developer_id,
              g.developer_url,
              g.developer_name,
              g.ad_networks,
              g.store_scanned_at,
              g.installs_scanned_at,
              g.first_seen_at,
              g.last_seen_at,
              g.discovery_source,
              cm.latest_creative_seen,
              cm.total_creatives,
              CASE
                WHEN cm.latest_creative_seen IS NOT NULL
                 AND cm.latest_creative_seen >= (NOW() - INTERVAL '14 days') THEN 'active'
                WHEN cm.latest_creative_seen IS NOT NULL
                 AND cm.latest_creative_seen < (NOW() - INTERVAL '14 days') THEN 'closed'
                WHEN COALESCE(g.ad_count, 0) > 0
                 AND (g.last_seen_at >= (NOW() - INTERVAL '14 days') OR g.store_scanned_at >= (NOW() - INTERVAL '14 days')) THEN 'active'
                WHEN COALESCE(g.ad_count, 0) > 0
                 AND (g.last_seen_at < (NOW() - INTERVAL '14 days') OR g.last_seen_at IS NULL) THEN 'closed'
                WHEN g.card_status IN ('active', 'open') THEN 'active'
                WHEN g.card_status = 'closed' THEN 'closed'
                WHEN COALESCE(g.ad_count, 0) = 0 AND ag.account_id IS NOT NULL THEN 'closed'
                ELSE 'unscanned'
              END AS card_status
            FROM games g
            LEFT JOIN account_games ag ON g.id = ag.game_id
            LEFT JOIN accounts a ON ag.account_id = a.id
            LEFT JOIN competitors c ON a.competitor_id = c.id
            LEFT JOIN creative_meta cm ON cm.package_name = g.package_name
            ORDER BY g.ad_count DESC
          `),
          extensionPool.query('SELECT COUNT(*)::int AS count FROM games')
        ]);

        const competitors = compRes.rows;
        const accounts = accRes.rows;
        const gameRows = gamesRes.rows;

        const gamesByAccount = {};
        for (const g of gameRows) {
          if (g.account_id) {
            if (!gamesByAccount[g.account_id]) gamesByAccount[g.account_id] = [];
            gamesByAccount[g.account_id].push(g);
          }
        }

        const accountsByCompetitor = {};
        for (const acc of accounts) {
          if (!accountsByCompetitor[acc.competitor_id]) accountsByCompetitor[acc.competitor_id] = [];
          accountsByCompetitor[acc.competitor_id].push({
            ...acc,
            games: gamesByAccount[acc.id] || []
          });
        }

        const tree = competitors.map(comp => ({
          ...comp,
          accounts: accountsByCompetitor[comp.id] || []
        }));

        directoryCache.stats = {
          competitors: competitors.length,
          accounts: accounts.length,
          games: Number(totalGamesRes.rows[0]?.count) || 0
        };
        directoryCache.trending = gameRows;
        directoryCache.competitors = tree;
        directoryCache.expiresAt = Date.now() + 90000;
        return directoryCache;
      } finally {
        directoryCache.inflight = null;
      }
    })();

    return directoryCache.inflight;
  }

  function sendGzippedJson(req, res, body) {
    try {
      const acceptEncoding = String(req.headers['accept-encoding'] || '');
      if (acceptEncoding.includes('gzip')) {
        const jsonStr = JSON.stringify(body);
        if (jsonStr && jsonStr.length >= 2048) {
          const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          return res.send(compressed);
        }
      }
    } catch {}
    return res.json(body);
  }

  // Wrap express.response.json globally so ALL large JSON responses (/api/play/overview, /api/amazon/overview, etc.)
  // are automatically gzip-compressed when the browser accepts gzip.
  const originalResJson = express.response.json;
  express.response.json = function atlasCompressedJson(body) {
    try {
      const req = this.req;
      if (req && req.method !== 'GET' && req.method !== 'OPTIONS') {
        invalidateDirectoryCache();
      }
      const acceptEncoding = String(req?.headers?.['accept-encoding'] || '');
      if (acceptEncoding.includes('gzip') && !this.headersSent && !this.getHeader('Content-Encoding')) {
        const jsonStr = JSON.stringify(body);
        if (jsonStr && jsonStr.length >= 2048) {
          const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
          this.setHeader('Content-Type', 'application/json; charset=utf-8');
          this.setHeader('Content-Encoding', 'gzip');
          this.setHeader('Vary', 'Accept-Encoding');
          return this.send(compressed);
        }
      }
    } catch {}
    return originalResJson.call(this, body);
  };

  const originalPost = express.application.post;
  express.application.post = function atlasDiscoveryPost(path, ...handlers) {
    if (path === '/api/scan') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function atlasScanStartBridge(req, res, next) {
          const originalJson = res.json.bind(res);
          res.json = body => {
            if (body?.status === 'initiated' && body?.scanId) beginScan(body.scanId);
            res.json = originalJson;
            return originalJson(body);
          };
          return handler(req, res, next);
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  let lastSyncedTerminalScanKey = null;
  const originalGet = express.application.get;
  express.application.get = function atlasDiscoveryGet(path, ...handlers) {
    if (path === '/api/scan-status') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function atlasScanStatusBridge(req, res, next) {
          const originalJson = res.json.bind(res);
          res.json = body => {
            // Only sync legacy accounts -> play_publishers ONCE per completed scan!
            const scanKey = `${body?.scanId || 'scan'}:${body?.finishedAt || ''}`;
            if (
              body?.isComplete &&
              scanKey !== lastSyncedTerminalScanKey &&
              typeof syncLegacyAccountsAndCompetitors === 'function'
            ) {
              lastSyncedTerminalScanKey = scanKey;
              invalidateDirectoryCache();
              void syncLegacyAccountsAndCompetitors(extensionPool).catch(() => {});
            }
            res.json = originalJson;
            return originalJson(mergeScanStatus(body));
          };
          return handler(req, res, next);
        };
      });
    } else if (path === '/api/trending') {
      return originalGet.call(this, path, async (req, res) => {
        try {
          const data = await ensureDirectoryDataLoaded();
          return sendGzippedJson(req, res, data.trending);
        } catch (err) {
          console.error('[Fast Trending Error]:', err.message);
          return res.status(500).json({ error: 'Fail' });
        }
      });
    } else if (path === '/api/competitors') {
      return originalGet.call(this, path, async (req, res) => {
        try {
          const data = await ensureDirectoryDataLoaded();
          return sendGzippedJson(req, res, data.competitors);
        } catch (err) {
          console.error('[Fast Competitors Error]:', err.message);
          return res.status(500).json({ error: 'Fail' });
        }
      });
    } else if (path === '/api/stats') {
      return originalGet.call(this, path, async (req, res) => {
        try {
          if (directoryCache.stats && directoryCache.expiresAt > Date.now()) {
            return res.json(directoryCache.stats);
          }
          const statsRes = await extensionPool.query(`
            SELECT
              (SELECT COUNT(*)::int FROM competitors) AS competitors,
              (SELECT COUNT(*)::int FROM accounts) AS accounts,
              (SELECT COUNT(*)::int FROM games) AS games
          `);
          const row = statsRes.rows[0] || {};
          const stats = {
            competitors: Number(row.competitors || 0),
            accounts: Number(row.accounts || 0),
            games: Number(row.games || 0)
          };
          directoryCache.stats = stats;
          return res.json(stats);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      });
    }
    return originalGet.call(this, path, ...handlers);
  };
}

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    await initializeIntelligenceFeatures(extensionPool);
    await initializeVideoLifecycle(extensionPool);
    await initializeVideoMetadata(extensionPool);
    await initializePlayTelemetryStorage(extensionPool);
    await initializeAmazonStorage(extensionPool);
    await initializePlayStoreStorage(extensionPool);
    await initializeCompetitorGroupsStorage(extensionPool);
    console.log('🎬 [Atlas Intelligence] Video library + editable metadata + keyword + Play telemetry + Amazon + Play Store Intelligence + Competitor Groups storage ready.');
  } catch (error) {
    initialized = false;
    console.error('⚠️ [Atlas Intelligence] Initialization failed:', error.message);
  }
}

const originalListen = express.application.listen;
express.application.listen = function atlasExtensionListen(...args) {
  if (!registered) {
    registered = true;
    registerVideoMetadataRoutes({ app: this, pool: extensionPool });
    registerIntelligenceRoutes({ app: this, pool: extensionPool, gplay });
    registerVideoLifecycleRoutes({ app: this, pool: extensionPool });
    registerPlayTelemetryRoutes({ app: this, pool: extensionPool });
    registerAmazonRoutes({ app: this, pool: extensionPool });
    registerPlayStoreRoutes({ app: this, pool: extensionPool });
    registerCompetitorGroupRoutes({ app: this, pool: extensionPool });
  }
  void initialize();
  return originalListen.apply(this, args);
};

void initialize();

module.exports = {
  extensionPool
};
