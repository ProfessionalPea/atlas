const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;
const {
  fetchPlayStoreDs5,
  runInstallVelocityPipeline,
  runFullTelemetryForPackage
} = require('./PlayStoreTelemetry');
const {
  COUNTRY_CODES,
  normalizePackageName,
  scanPackageCountries
} = require('./CountryAvailabilityScanner');

let playScanStatus = {
  running: false,
  state: 'idle',
  phase: 'idle',
  mode: 'batch', // 'batch' | 'update_all' | 'list' | 'single'
  isCancelled: false,
  isComplete: false,
  isError: false,
  currentPublisher: null,
  publisherIndex: 0,
  completedPublishers: 0,
  totalPublishers: 0,
  gamesFoundInCurrent: 0,
  totalGamesSaved: 0,
  newGamesDiscovered: 0,
  startedAt: null,
  finishedAt: null,
  resultsSummary: [],
  failedLinks: [],
  log: '> Ready to scan Google Play Store publisher accounts.'
};
let activePlayScanCancelled = false;

// Resumable Batch Country Scanner Queue State
let countryBatchQueue = {
  running: false,
  paused: false,
  cancelled: false,
  state: 'idle', // 'idle' | 'running' | 'paused' | 'complete' | 'cancelled' | 'error'
  scopeLabel: '',
  skipDays: 7,
  totalPackages: 0,
  completedPackages: 0,
  skippedPackages: 0,
  failedPackages: [],
  currentPackage: null,
  currentAppTitle: null,
  currentCountryChecked: 0,
  currentCountryTotal: COUNTRY_CODES.length,
  currentCountryCode: null,
  pendingPackages: [],
  startedAt: null,
  finishedAt: null,
  log: '> Ready for batch country availability scans.'
};

function normalizePlayPublisherKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function fixUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

function parseReleaseDateIso(value) {
  if (!value || value === 'Unknown') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'unknown') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str + ' UTC');
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  const fallback = new Date(str);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Validate a Play Store developer URL or raw publisher name / numeric developer ID.
 * Supports:
 * - https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio
 * - https://play.google.com/store/apps/dev?id=6602199032879859147
 * - https://play.google.com/store/search?q=pub:Lion+Gamez+Studio&c=apps
 * - Raw publisher name or numeric developer ID
 */
function validatePlayStoreUrl(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) {
    return { valid: false, raw, reason: 'Empty input' };
  }

  let publisher = null;
  let developerId = null;
  let isNumericDevPage = false;

  if (/^https?:\/\//i.test(raw) || /^play\.google\.com\//i.test(raw)) {
    const normalizedRaw = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed;
    try {
      parsed = new URL(normalizedRaw);
    } catch {
      return { valid: false, raw, reason: 'Malformed URL' };
    }

    if (!/^(?:www\.)?play\.google\.com$/i.test(parsed.hostname)) {
      return { valid: false, raw, reason: `Unsupported host: ${parsed.hostname} (must be play.google.com)` };
    }

    const pathname = parsed.pathname || '';
    const idParam = parsed.searchParams.get('id');
    const qParam = parsed.searchParams.get('q');

    if (/\/store\/apps\/dev\/?$/i.test(pathname) && idParam) {
      const cleanId = decodeURIComponent(idParam.replace(/\+/g, ' ')).trim();
      if (!cleanId) {
        return { valid: false, raw, reason: 'Missing developer ID in /store/apps/dev?id=' };
      }
      isNumericDevPage = /^\d+$/.test(cleanId);
      if (isNumericDevPage) {
        developerId = cleanId;
      }
      publisher = cleanId;
    } else if (/\/store\/apps\/developer\/?$/i.test(pathname) && idParam) {
      const cleanName = decodeURIComponent(idParam.replace(/\+/g, ' ')).trim();
      if (!cleanName) {
        return { valid: false, raw, reason: 'Missing publisher name in /store/apps/developer?id=' };
      }
      publisher = cleanName;
      if (/^\d+$/.test(cleanName)) {
        developerId = cleanName;
        isNumericDevPage = true;
      }
    } else if (/\/store\/search\/?$/i.test(pathname) && qParam) {
      const cleanedQ = decodeURIComponent(qParam.replace(/\+/g, ' '))
        .replace(/^pub:/i, '')
        .trim();
      if (!cleanedQ) {
        return { valid: false, raw, reason: 'Empty search query' };
      }
      publisher = cleanedQ;
    } else if (/\/store\/apps\/details\/?$/i.test(pathname)) {
      return {
        valid: false,
        raw,
        reason: 'This is a single game URL (/store/apps/details), not a publisher developer page (/store/apps/developer?id=...)'
      };
    } else {
      return {
        valid: false,
        raw,
        reason: 'URL must be a Google Play developer page (/store/apps/developer?id=... or /store/apps/dev?id=...)'
      };
    }
  } else {
    // Allow raw publisher name or numeric developer ID
    const cleanRaw = raw.replace(/^pub:/i, '').trim();
    if (cleanRaw.length < 2 || cleanRaw.length > 120) {
      return { valid: false, raw, reason: 'Publisher name must be between 2 and 120 characters' };
    }
    publisher = cleanRaw;
    if (/^\d{10,25}$/.test(cleanRaw)) {
      developerId = cleanRaw;
      isNumericDevPage = true;
    }
  }

  const normalizedKey = normalizePlayPublisherKey(publisher);
  const encodedId = encodeURIComponent(publisher).replace(/%20/g, '+');
  const normalizedUrl = isNumericDevPage
    ? `https://play.google.com/store/apps/dev?id=${encodeURIComponent(developerId || publisher)}`
    : `https://play.google.com/store/apps/developer?id=${encodedId}`;

  return {
    valid: true,
    raw,
    publisher,
    developerId,
    isNumericDevPage,
    normalizedKey,
    normalizedUrl
  };
}

function validatePlayBatch(rawLinks) {
  const seen = new Set();
  const list = Array.isArray(rawLinks) ? rawLinks : [];
  return list.map((raw) => {
    const v = validatePlayStoreUrl(raw);
    if (!v.valid) return { ...v, duplicate: false };
    const dup = seen.has(v.normalizedKey);
    seen.add(v.normalizedKey);
    return { ...v, duplicate: dup };
  });
}

function parseInputLinks(raw) {
  if (Array.isArray(raw)) {
    return raw
      .flatMap((item) => String(item || '').split(/[\r\n]+/))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return String(raw || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runWithTimeout(operation, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'PLAY_SCAN_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function mapWithConcurrency(items, concurrency, worker, shouldStop = () => false) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, Number(concurrency) || 1), Math.max(1, items.length));

  await Promise.all(
    Array.from({ length: count }, async () => {
      while (!shouldStop()) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          results[idx] = await worker(items[idx], idx);
        } catch (err) {
          results[idx] = null;
        }
      }
    })
  );

  return results;
}

/**
 * Fetch all apps for a Play Store publisher account using gplay.developer.
 * Handles Google Play's case-sensitive developer?id= endpoint by:
 * 1. Trying the exact publisher name / devId
 * 2. Trying known canonical developer_name or developer_id from existing games in DB
 * 3. Trying lowercase / titlecase variants if 404
 * 4. Unioning results when both developer name and numeric developer_id exist
 */
async function fetchPlayDeveloperApps(pool, target) {
  const candidateDevIds = [];
  const seenCandidates = new Set();
  const addCandidate = (val) => {
    const clean = String(val || '').trim();
    if (!clean || seenCandidates.has(clean)) return;
    seenCandidates.add(clean);
    candidateDevIds.push(clean);
  };

  addCandidate(target.publisher);
  if (target.developerId) addCandidate(target.developerId);

  // Look up existing account and any known games for canonical developer_name / developer_id
  let existingPub = null;
  try {
    const pubRes = await pool.query(
      `SELECT p.*,
              (SELECT g.package_name FROM account_games ag JOIN games g ON g.id = ag.game_id WHERE ag.account_id = p.id LIMIT 1) AS sample_pkg,
              (SELECT g.developer_name FROM account_games ag JOIN games g ON g.id = ag.game_id WHERE ag.account_id = p.id AND g.developer_name IS NOT NULL LIMIT 1) AS sample_dev_name,
              (SELECT g.developer_id FROM account_games ag JOIN games g ON g.id = ag.game_id WHERE ag.account_id = p.id AND g.developer_id IS NOT NULL LIMIT 1) AS sample_dev_id
       FROM play_publishers p
       WHERE p.normalized_name = $1
          OR ($2::text IS NOT NULL AND p.developer_id = $2)
       LIMIT 1`,
      [target.normalizedKey, target.developerId || null]
    );
    existingPub = pubRes.rows[0] || null;
    if (existingPub) {
      addCandidate(existingPub.publisher_name);
      addCandidate(existingPub.sample_dev_name);
      addCandidate(existingPub.developer_id);
      addCandidate(existingPub.sample_dev_id);
    }
  } catch {}

  // Case variants for case-sensitive developer?id= (e.g. "Crushiz" -> "crushiz")
  const baseName = String(target.publisher || '').trim();
  if (baseName && !/^\d+$/.test(baseName)) {
    addCandidate(baseName.toLowerCase());
    const titleCased = baseName
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    addCandidate(titleCased);
  }

  const appsByPackage = new Map();
  let resolvedPublisherName = existingPub?.publisher_name || target.publisher;
  let resolvedDeveloperId = existingPub?.developer_id || target.developerId || null;
  let lastError = null;
  let anySucceeded = false;

  const tryFetchDevId = async (devId) => {
    try {
      const list = await runWithTimeout(
        () => gplay.developer({ devId, country: 'us', lang: 'en', num: 200 }),
        12000,
        `gplay.developer(${devId})`
      );
      if (Array.isArray(list) && list.length > 0) {
        anySucceeded = true;
        for (const item of list) {
          const pkg = String(item?.appId || '').trim();
          if (!pkg) continue;
          if (!appsByPackage.has(pkg)) {
            appsByPackage.set(pkg, item);
          }
          if (item.developer && !/^\d+$/.test(String(item.developer))) {
            resolvedPublisherName = String(item.developer).trim();
          }
          if (item.developerId && /^\d+$/.test(String(item.developerId))) {
            resolvedDeveloperId = String(item.developerId).trim();
          }
        }
        return list.length;
      }
      return 0;
    } catch (err) {
      lastError = err;
      return -1;
    }
  };

  for (const candidate of candidateDevIds) {
    const count = await tryFetchDevId(candidate);
    // If we found apps with a non-numeric developer name, also check numeric developerId if discovered
    if (count > 0 && !/^\d+$/.test(candidate)) {
      break;
    }
  }

  // If we resolved a numeric developerId and haven't queried it yet, or vice-versa (resolved a name from numeric ID), query it too
  if (resolvedDeveloperId && !seenCandidates.has(resolvedDeveloperId)) {
    addCandidate(resolvedDeveloperId);
    await tryFetchDevId(resolvedDeveloperId);
  }
  if (resolvedPublisherName && !seenCandidates.has(resolvedPublisherName) && !/^\d+$/.test(resolvedPublisherName)) {
    addCandidate(resolvedPublisherName);
    await tryFetchDevId(resolvedPublisherName);
  }

  // Fallback: if 0 apps found and we have a sample_pkg in DB, inspect its ds:5 to learn the exact Play Store developerName
  if (appsByPackage.size === 0 && existingPub?.sample_pkg) {
    try {
      const ds5 = await fetchPlayStoreDs5(existingPub.sample_pkg, { timeoutMs: 8000 });
      if (ds5?.developerName && !seenCandidates.has(ds5.developerName)) {
        resolvedPublisherName = ds5.developerName;
        await tryFetchDevId(ds5.developerName);
      }
    } catch {}
  }

  return {
    apps: [...appsByPackage.values()],
    resolvedPublisherName,
    resolvedDeveloperId,
    anySucceeded,
    lastError
  };
}

/**
 * Scan a single Play Store publisher, upsert its games into `games` and `account_games`,
 * enrich new/unscanned games via `fetchPlayStoreDs5` + `runInstallVelocityPipeline`,
 * and update `play_publishers` and `play_scan_snapshots`.
 */
async function scanAndSavePlayPublisher(pool, targetInput, options = {}) {
  const validated = typeof targetInput === 'string' ? validatePlayStoreUrl(targetInput) : targetInput;
  if (!validated || !validated.valid) {
    return {
      status: 'error',
      statusDetail: validated?.reason || 'Invalid Play Store publisher link',
      publisher: validated?.raw || 'Unknown',
      games: [],
      addedPackages: []
    };
  }

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;

  onProgress({
    phase: 'fetching_catalogue',
    publisher: validated.publisher,
    found: 0
  });

  const devResult = await fetchPlayDeveloperApps(pool, validated);
  const rawApps = devResult.apps || [];
  const pubName = devResult.resolvedPublisherName || validated.publisher;
  const normKey = normalizePlayPublisherKey(pubName);
  const devId = devResult.resolvedDeveloperId || validated.developerId || null;
  const sourceUrl =
    validated.normalizedUrl ||
    `https://play.google.com/store/apps/developer?id=${encodeURIComponent(pubName).replace(/%20/g, '+')}`;

  // Look up existing publisher record
  const existingPubRes = await pool.query(
    `SELECT * FROM play_publishers WHERE normalized_name = $1 OR normalized_name = $2 ORDER BY id ASC LIMIT 1`,
    [normKey, validated.normalizedKey]
  );
  let pubRecord = existingPubRes.rows[0] || null;

  // If 0 apps returned and an error occurred, preserve existing data without overwriting counts
  if (rawApps.length === 0 && !devResult.anySucceeded) {
    const errDetail = devResult.lastError?.message || 'Google Play developer page returned 0 apps or 404';
    if (pubRecord) {
      await pool.query(
        `UPDATE play_publishers
         SET last_scan_status = 'error',
             last_scan_detail = $2,
             last_scanned_at = now()
         WHERE id = $1`,
        [pubRecord.id, errDetail]
      );
      await pool.query(
        `INSERT INTO play_scan_snapshots (
           publisher_id, publisher_name, status, status_detail, total_games, free_games, paid_games, new_games_count
         ) VALUES ($1, $2, 'error', $3, $4, $5, $6, 0)`,
        [
          pubRecord.id,
          pubRecord.publisher_name,
          errDetail,
          pubRecord.total_games || 0,
          pubRecord.free_games || 0,
          pubRecord.paid_games || 0
        ]
      );
    }
    return {
      publisherId: pubRecord?.id || null,
      publisher: pubRecord?.publisher_name || pubName,
      sourceUrl,
      status: 'error',
      statusDetail: errDetail,
      games: [],
      addedPackages: []
    };
  }

  // Ensure publisher exists in play_publishers (and keep legacy accounts table in sync)
  if (!pubRecord) {
    let legacyAccountRes = await pool.query(
      `SELECT id, competitor_id FROM accounts WHERE LOWER(TRIM(publisher_name)) = $1 ORDER BY id ASC LIMIT 1`,
      [normKey]
    );
    let accountId = legacyAccountRes.rows[0]?.id || null;
    if (!accountId) {
      const insAcc = await pool.query(
        `INSERT INTO accounts (competitor_id, publisher_name, normalized_name)
         VALUES (NULL, $1, $2)
         RETURNING id`,
        [pubName, pubName.toLowerCase().replace(/[^a-z0-9]/g, '')]
      );
      accountId = insAcc.rows[0].id;
    }

    const insPub = await pool.query(
      `INSERT INTO play_publishers (
         id, publisher_name, normalized_name, developer_id, source_url,
         last_scan_status, last_scanned_at
       ) VALUES ($1, $2, $3, $4, $5, 'scanning', now())
       ON CONFLICT (normalized_name) DO UPDATE SET
         publisher_name = EXCLUDED.publisher_name,
         developer_id = COALESCE(EXCLUDED.developer_id, play_publishers.developer_id),
         source_url = COALESCE(EXCLUDED.source_url, play_publishers.source_url),
         last_scanned_at = now()
       RETURNING *`,
      [accountId, pubName, normKey, devId, sourceUrl]
    );
    pubRecord = insPub.rows[0];
  }

  const publisherId = pubRecord.id;

  // Check which packages already exist in `games` and `account_games` for this publisher
  const pkgList = rawApps.map((a) => String(a.appId || '').trim()).filter(Boolean);
  const existingGamesRes = pkgList.length > 0
    ? await pool.query(
        `SELECT id, package_name, release_date, released, real_installs, installs, store_scanned_at
         FROM games
         WHERE package_name = ANY($1::text[])`,
        [pkgList]
      )
    : { rows: [] };
  const existingGameByPkg = new Map(existingGamesRes.rows.map((g) => [g.package_name, g]));

  const prevLinkedRes = await pool.query(
    `SELECT g.package_name
     FROM account_games ag
     JOIN games g ON g.id = ag.game_id
     WHERE ag.account_id = $1`,
    [publisherId]
  );
  const prevLinkedSet = new Set(prevLinkedRes.rows.map((r) => r.package_name));

  const addedPackages = [];
  const packagesNeedingTelemetry = [];

  for (const appItem of rawApps) {
    if (isCancelled()) break;
    const pkg = String(appItem.appId || '').trim();
    if (!pkg) continue;

    const existing = existingGameByPkg.get(pkg);
    const isNewToAtlas = !existing;
    const isNewToPublisher = !prevLinkedSet.has(pkg);
    if (isNewToAtlas || isNewToPublisher) {
      addedPackages.push(pkg);
    }

    const isPaid = appItem.free === false || Number(appItem.price) > 0;
    const priceNum = isPaid && Number.isFinite(Number(appItem.price)) ? Number(appItem.price) : null;
    const currency = isPaid ? (appItem.currency || 'USD') : null;
    const priceText = isPaid ? (appItem.priceText || (priceNum ? `$${priceNum}` : null)) : 'Free';
    const developerUrl = devId
      ? `https://play.google.com/store/apps/dev?id=${encodeURIComponent(devId)}`
      : sourceUrl;

    const upsertRes = await pool.query(
      `INSERT INTO games (
         package_name, title, category, rating, ratings_count, icon,
         description, short_description, installs, min_installs, released,
         updated, ad_count, developer_id, developer_url, developer_name,
         is_paid, price, currency, price_text,
         first_seen_at, last_seen_at, discovery_source
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, 0, $13, $14, $15,
         $16, $17, $18, $19,
         now(), now(), 'play_publisher'
       )
       ON CONFLICT (package_name) DO UPDATE SET
         title = COALESCE(NULLIF(EXCLUDED.title, ''), games.title),
         rating = CASE WHEN EXCLUDED.rating > 0 THEN EXCLUDED.rating ELSE games.rating END,
         icon = COALESCE(EXCLUDED.icon, games.icon),
         short_description = COALESCE(NULLIF(EXCLUDED.short_description, ''), games.short_description),
         developer_id = COALESCE(EXCLUDED.developer_id, games.developer_id),
         developer_url = COALESCE(EXCLUDED.developer_url, games.developer_url),
         developer_name = COALESCE(EXCLUDED.developer_name, games.developer_name),
         is_paid = EXCLUDED.is_paid,
         price = COALESCE(EXCLUDED.price, games.price),
         currency = COALESCE(EXCLUDED.currency, games.currency),
         price_text = COALESCE(EXCLUDED.price_text, games.price_text),
         last_seen_at = now()
       RETURNING id, release_date, real_installs, store_scanned_at`,
      [
        pkg,
        appItem.title || pkg,
        existing?.category || 'Game',
        Number(appItem.score) || 0,
        existing?.ratings_count || 0,
        fixUrl(appItem.icon),
        appItem.summary || existing?.description || '',
        appItem.summary || null,
        existing?.installs || '0+',
        existing?.min_installs || 0,
        existing?.released || 'Unknown',
        existing?.updated || Date.now(),
        devId,
        developerUrl,
        pubName,
        isPaid,
        priceNum,
        currency,
        priceText
      ]
    );

    const gameRow = upsertRes.rows[0];
    await pool.query(
      `INSERT INTO account_games (account_id, game_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [publisherId, gameRow.id]
    );

    const needsDs5 =
      options.forceTelemetry === true ||
      !gameRow.release_date ||
      gameRow.real_installs == null ||
      !gameRow.store_scanned_at;

    if (needsDs5) {
      packagesNeedingTelemetry.push(pkg);
    }
  }

  // Enrich new or incomplete games via ds:5 + install velocity pipeline with bounded concurrency (4)
  if (packagesNeedingTelemetry.length > 0 && !isCancelled()) {
    let enrichedCount = 0;
    await mapWithConcurrency(
      packagesNeedingTelemetry,
      4,
      async (pkg) => {
        if (isCancelled()) return;
        try {
          await runWithTimeout(
            () => runInstallVelocityPipeline(pool, pkg),
            10000,
            `ds:5 velocity for ${pkg}`
          );
          // Also backfill ratings_count and rating from ds:5 if available
        } catch {
          // Fallback to gplay.app if ds:5 fails
          try {
            const appData = await runWithTimeout(
              () => gplay.app({ appId: pkg, country: 'us', lang: 'en' }),
              8000,
              `gplay.app(${pkg})`
            );
            if (appData) {
              const relIso = parseReleaseDateIso(appData.released);
              await pool.query(
                `UPDATE games
                 SET category = COALESCE($2, category),
                     rating = COALESCE($3, rating),
                     ratings_count = COALESCE($4, ratings_count),
                     installs = COALESCE($5, installs),
                     min_installs = COALESCE($6, min_installs),
                     released = COALESCE($7, released),
                     release_date = COALESCE($8::date, release_date),
                     updated = COALESCE($9, updated),
                     header_image = COALESCE($10, header_image),
                     store_scanned_at = now()
                 WHERE package_name = $1`,
                [
                  pkg,
                  appData.genre || 'Game',
                  Number(appData.score) || 0,
                  Number(appData.ratings) || 0,
                  appData.installs || '0+',
                  Number(appData.minInstalls) || 0,
                  appData.released || 'Unknown',
                  relIso,
                  appData.updated || Date.now(),
                  fixUrl(appData.headerImage)
                ]
              );
            }
          } catch {}
        } finally {
          enrichedCount += 1;
          onProgress({
            phase: 'enriching_games',
            publisher: pubName,
            found: rawApps.length,
            enriched: enrichedCount,
            totalToEnrich: packagesNeedingTelemetry.length
          });
        }
      },
      isCancelled
    );
  }

  // Recompute aggregate publisher metrics from all linked games
  const aggRes = await pool.query(
    `SELECT
       COUNT(DISTINCT g.id)::int AS total_games,
       COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = false)::int AS free_games,
       COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = true)::int AS paid_games,
       AVG(NULLIF(g.rating, 0))::double precision AS avg_rating,
       COALESCE(SUM(COALESCE(g.ratings_count, 0)), 0)::bigint AS total_reviews,
       COALESCE(SUM(COALESCE(g.real_installs, g.min_installs, 0)), 0)::bigint AS total_installs,
       COALESCE(SUM(COALESCE(g.installs_delta_1d, 0)), 0)::bigint AS daily_installs_delta
     FROM account_games ag
     JOIN games g ON g.id = ag.game_id
     WHERE ag.account_id = $1
       AND COALESCE(g.is_suspended, false) = false`,
    [publisherId]
  );
  const agg = aggRes.rows[0] || {};
  const totalGames = Number(agg.total_games) || 0;
  const freeGames = Number(agg.free_games) || 0;
  const paidGames = Number(agg.paid_games) || 0;
  const avgRating = agg.avg_rating != null ? Number(Number(agg.avg_rating).toFixed(2)) : null;
  const totalReviews = Number(agg.total_reviews) || 0;
  const totalInstalls = Number(agg.total_installs) || 0;
  const dailyDelta = Number(agg.daily_installs_delta) || 0;

  await pool.query(
    `UPDATE play_publishers
     SET publisher_name = $2,
         developer_id = COALESCE($3, developer_id),
         source_url = COALESCE($4, source_url),
         total_games = $5,
         free_games = $6,
         paid_games = $7,
         avg_rating = $8,
         total_reviews = $9,
         total_installs = $10,
         daily_installs_delta = $11,
         last_scan_status = 'complete',
         last_scan_detail = NULL,
         last_scanned_at = now(),
         last_successful_scan_at = now()
     WHERE id = $1`,
    [
      publisherId,
      pubName,
      devId,
      sourceUrl,
      totalGames,
      freeGames,
      paidGames,
      avgRating,
      totalReviews,
      totalInstalls,
      dailyDelta
    ]
  );

  await pool.query(
    `INSERT INTO play_scan_snapshots (
       publisher_id, publisher_name, status, status_detail,
       total_games, free_games, paid_games, new_games_count, added_packages
     ) VALUES ($1, $2, 'complete', NULL, $3, $4, $5, $6, $7::jsonb)`,
    [
      publisherId,
      pubName,
      totalGames,
      freeGames,
      paidGames,
      addedPackages.length,
      JSON.stringify(addedPackages)
    ]
  );

  return {
    publisherId,
    publisher: pubName,
    sourceUrl,
    status: 'complete',
    statusDetail: null,
    totalGames,
    freeGames,
    paidGames,
    addedPackages
  };
}

/**
 * Initialize Play Store Intelligence schema non-destructively and backfill from
 * existing `competitors`, `accounts`, `account_games`, and `games`.
 */
async function initializePlayStoreStorage(pool) {
  await pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS discovery_source TEXT DEFAULT 'play_publisher';

    ALTER TABLE games
      ALTER COLUMN first_seen_at SET DEFAULT now();

    WITH min_ads AS (
      SELECT game_id, MIN(first_seen_at) AS min_seen
      FROM ad_creatives
      WHERE game_id IS NOT NULL
      GROUP BY game_id
    )
    UPDATE games g
    SET first_seen_at = COALESCE(
      g.store_scanned_at,
      g.installs_scanned_at,
      ma.min_seen,
      now()
    )
    FROM min_ads ma
    WHERE g.first_seen_at IS NULL AND g.id = ma.game_id;

    UPDATE games
    SET first_seen_at = COALESCE(store_scanned_at, installs_scanned_at, now())
    WHERE first_seen_at IS NULL;

    CREATE TABLE IF NOT EXISTS play_publishers (
      id SERIAL PRIMARY KEY,
      publisher_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      developer_id TEXT,
      source_url TEXT NOT NULL,
      total_games INTEGER NOT NULL DEFAULT 0,
      free_games INTEGER NOT NULL DEFAULT 0,
      paid_games INTEGER NOT NULL DEFAULT 0,
      avg_rating DOUBLE PRECISION,
      total_reviews BIGINT NOT NULL DEFAULT 0,
      total_installs BIGINT NOT NULL DEFAULT 0,
      daily_installs_delta BIGINT NOT NULL DEFAULT 0,
      last_scan_status TEXT DEFAULT 'unscanned',
      last_scan_detail TEXT,
      last_scanned_at TIMESTAMPTZ,
      last_successful_scan_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS play_lists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ads_id TEXT,
      description TEXT,
      competitor_id INTEGER REFERENCES competitors(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS play_list_publishers (
      list_id INTEGER NOT NULL REFERENCES play_lists(id) ON DELETE CASCADE,
      publisher_id INTEGER NOT NULL REFERENCES play_publishers(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (list_id, publisher_id)
    );

    CREATE INDEX IF NOT EXISTS idx_play_list_publishers_pub ON play_list_publishers(publisher_id);

    CREATE TABLE IF NOT EXISTS play_scan_snapshots (
      id SERIAL PRIMARY KEY,
      publisher_id INTEGER REFERENCES play_publishers(id) ON DELETE CASCADE,
      publisher_name TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      total_games INTEGER NOT NULL DEFAULT 0,
      free_games INTEGER NOT NULL DEFAULT 0,
      paid_games INTEGER NOT NULL DEFAULT 0,
      new_games_count INTEGER NOT NULL DEFAULT 0,
      added_packages JSONB DEFAULT '[]'::jsonb,
      scanned_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await syncLegacyAccountsAndCompetitors(pool);
}

/**
 * Sync legacy `competitors` and `accounts` rows into `play_lists`, `play_publishers`, and `play_list_publishers`,
 * consolidating duplicate publisher rows and refreshing aggregate publisher stats.
 */
async function syncLegacyAccountsAndCompetitors(pool) {
  // Sync existing `competitors` into `play_lists`
  await pool.query(`
    INSERT INTO play_lists (name, ads_id, description, competitor_id)
    SELECT c.name, c.ads_id,
           CASE WHEN c.ads_id IS NOT NULL THEN 'Imported from Competitor ' || c.ads_id ELSE 'Competitor Group' END,
           c.id
    FROM competitors c
    WHERE NOT EXISTS (
      SELECT 1 FROM play_lists pl WHERE pl.competitor_id = c.id OR LOWER(TRIM(pl.name)) = LOWER(TRIM(c.name))
    );
  `);

  // Consolidate duplicate accounts in `accounts` (same LOWER(TRIM(publisher_name))) into the lowest account_id
  // in 3 bulk SQL statements instead of per-row round-trips over remote PostgreSQL!
  await pool.query(`
    INSERT INTO play_publishers (id, publisher_name, normalized_name, source_url)
    SELECT
      MIN(id) AS canonical_id,
      (array_agg(publisher_name ORDER BY id ASC))[1] AS canonical_name,
      LOWER(TRIM(publisher_name)) AS norm_key,
      'https://play.google.com/store/apps/developer?id=' || REPLACE( (array_agg(publisher_name ORDER BY id ASC))[1], ' ', '+' ) AS source_url
    FROM accounts
    WHERE TRIM(COALESCE(publisher_name, '')) <> ''
    GROUP BY LOWER(TRIM(publisher_name))
    ON CONFLICT (normalized_name) DO NOTHING;
  `);

  // Copy any `account_games` links from secondary duplicate account rows onto their canonical `play_publishers.id`
  await pool.query(`
    INSERT INTO account_games (account_id, game_id)
    SELECT p.id, ag.game_id
    FROM accounts a
    JOIN play_publishers p ON p.normalized_name = LOWER(TRIM(a.publisher_name))
    JOIN account_games ag ON ag.account_id = a.id
    WHERE a.id <> p.id
    ON CONFLICT DO NOTHING;
  `);

  // Link every publisher to every `play_lists` entry corresponding to its `accounts.competitor_id`
  await pool.query(`
    INSERT INTO play_list_publishers (list_id, publisher_id)
    SELECT DISTINCT pl.id, p.id
    FROM accounts a
    JOIN play_publishers p ON p.normalized_name = LOWER(TRIM(a.publisher_name))
    JOIN play_lists pl ON pl.competitor_id = a.competitor_id
    WHERE a.competitor_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `);

  // Advance play_publishers sequence past max(id)
  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence('play_publishers', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM play_publishers), 1), COALESCE((SELECT MAX(id) FROM accounts), 1))
    );
  `);

  // Backfill aggregate metrics on `play_publishers` from existing `account_games` + `games`
  await pool.query(`
    WITH agg AS (
      SELECT
        p.id AS pub_id,
        COUNT(DISTINCT g.id)::int AS total_games,
        COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = false)::int AS free_games,
        COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = true)::int AS paid_games,
        AVG(NULLIF(g.rating, 0))::double precision AS avg_rating,
        COALESCE(SUM(COALESCE(g.ratings_count, 0)), 0)::bigint AS total_reviews,
        COALESCE(SUM(COALESCE(g.real_installs, g.min_installs, 0)), 0)::bigint AS total_installs,
        COALESCE(SUM(COALESCE(g.installs_delta_1d, 0)), 0)::bigint AS daily_installs_delta,
        MAX(COALESCE(g.store_scanned_at, g.installs_scanned_at, g.last_seen_at)) AS latest_game_scan,
        MAX(g.developer_id) FILTER (WHERE g.developer_id IS NOT NULL) AS dev_id
      FROM play_publishers p
      LEFT JOIN account_games ag ON ag.account_id = p.id
      LEFT JOIN games g ON g.id = ag.game_id AND COALESCE(g.is_suspended, false) = false
      GROUP BY p.id
    )
    UPDATE play_publishers p
    SET total_games = agg.total_games,
        free_games = agg.free_games,
        paid_games = agg.paid_games,
        avg_rating = agg.avg_rating,
        total_reviews = agg.total_reviews,
        total_installs = agg.total_installs,
        daily_installs_delta = agg.daily_installs_delta,
        developer_id = COALESCE(p.developer_id, agg.dev_id),
        last_scan_status = CASE
          WHEN p.last_scan_status IS NOT NULL AND p.last_scan_status <> 'unscanned' THEN p.last_scan_status
          WHEN agg.total_games > 0 THEN 'complete'
          ELSE 'unscanned'
        END,
        last_scanned_at = COALESCE(p.last_scanned_at, agg.latest_game_scan),
        last_successful_scan_at = COALESCE(
          p.last_successful_scan_at,
          CASE WHEN agg.total_games > 0 THEN COALESCE(agg.latest_game_scan, p.created_at) ELSE NULL END
        )
    FROM agg
    WHERE p.id = agg.pub_id;
  `);
}

/**
 * Read the Google Sheet 'Competitor Analysis' tab and preview/import lists + publisher accounts.
 */
async function fetchSheetCompetitorAnalysis(pool) {
  let authConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } else {
    authConfig.keyFile = path.join(__dirname, 'google-credentials.json');
  }
  const auth = new google.auth.GoogleAuth(authConfig);
  const sheets = google.sheets({ version: 'v4', auth });

  const settingsQuery = await pool.query("SELECT value FROM settings WHERE key = 'google_sheet_id'");
  const sheetId = settingsQuery.rows[0]?.value || '1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "'Competitor Analysis'!A1:Z300"
  });

  const rows = res.data.values || [];
  const headers = rows[0] || [];

  const existingPubsRes = await pool.query(`SELECT id, publisher_name, normalized_name FROM play_publishers`);
  const existingPubByKey = new Map(existingPubsRes.rows.map((p) => [p.normalized_name, p]));

  const existingListsRes = await pool.query(`SELECT id, name, ads_id FROM play_lists`);
  const existingListByName = new Map(
    existingListsRes.rows.map((l) => [String(l.name || '').trim().toLowerCase(), l])
  );

  const columns = [];
  let totalLinksInSheet = 0;
  const uniqueSheetPublishers = new Map();
  const invalidEntries = [];

  for (let colIdx = 0; colIdx < headers.length; colIdx++) {
    const rawHeader = String(headers[colIdx] || '').trim();
    if (!rawHeader) continue;

    // Parse "<Competitor Name> [<AR_ID>]"
    const match = rawHeader.match(/^(.*?)\s*\[(AR\d+)\]\s*$/i);
    const listName = (match ? match[1] : rawHeader).trim();
    const adsId = match ? match[2].toUpperCase() : null;

    const existingList = existingListByName.get(listName.toLowerCase()) || null;
    const colPublishers = [];
    const seenInCol = new Set();

    for (let r = 1; r < rows.length; r++) {
      const cell = rows[r] && rows[r][colIdx] ? String(rows[r][colIdx]).trim() : '';
      if (!cell) continue;
      totalLinksInSheet += 1;

      const v = validatePlayStoreUrl(cell);
      if (!v.valid) {
        invalidEntries.push({ column: listName, row: r + 1, raw: cell, reason: v.reason });
        continue;
      }

      if (seenInCol.has(v.normalizedKey)) continue;
      seenInCol.add(v.normalizedKey);

      const existsInDb = existingPubByKey.has(v.normalizedKey);
      colPublishers.push({
        publisher: v.publisher,
        normalizedKey: v.normalizedKey,
        normalizedUrl: v.normalizedUrl,
        developerId: v.developerId,
        alreadyInAtlas: existsInDb,
        existingPublisherId: existsInDb ? existingPubByKey.get(v.normalizedKey).id : null
      });

      if (!uniqueSheetPublishers.has(v.normalizedKey)) {
        uniqueSheetPublishers.set(v.normalizedKey, {
          ...v,
          alreadyInAtlas: existsInDb,
          lists: [listName]
        });
      } else {
        const entry = uniqueSheetPublishers.get(v.normalizedKey);
        if (!entry.lists.includes(listName)) entry.lists.push(listName);
      }
    }

    columns.push({
      rawHeader,
      listName,
      adsId,
      alreadyExistsAsList: Boolean(existingList),
      existingListId: existingList?.id || null,
      accountCount: colPublishers.length,
      newAccountCount: colPublishers.filter((p) => !p.alreadyInAtlas).length,
      accounts: colPublishers
    });
  }

  const allUnique = [...uniqueSheetPublishers.values()];
  return {
    sheetId,
    totalColumns: columns.length,
    totalLinksInSheet,
    uniquePublishersCount: allUnique.length,
    newPublishersCount: allUnique.filter((p) => !p.alreadyInAtlas).length,
    existingPublishersCount: allUnique.filter((p) => p.alreadyInAtlas).length,
    invalidCount: invalidEntries.length,
    invalidEntries: invalidEntries.slice(0, 25),
    columns
  };
}

/**
 * Helper to execute a single country availability scan and persist results to `package_country_scans`.
 */
async function executeAndSaveSingleCountryScan(pool, packageName, onProgress = () => {}) {
  const pkg = normalizePackageName(packageName);
  const gameRow = (
    await pool.query(`SELECT id, title, developer_name FROM games WHERE package_name = $1 LIMIT 1`, [pkg])
  ).rows[0];

  const { rows: scanRows } = await pool.query(
    `INSERT INTO package_country_scans (package_name, app_title, developer, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING *`,
    [pkg, gameRow?.title || null, gameRow?.developer_name || null]
  );
  const scan = scanRows[0];

  try {
    const countryResult = await scanPackageCountries(pkg, { onProgress });
    let appTitle = gameRow?.title || null;
    let developer = gameRow?.developer_name || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM package_country_scan_results WHERE scan_id = $1', [scan.id]);

      if (countryResult.results.length > 0) {
        const payloadJson = JSON.stringify(
          countryResult.results.map((item) => ({
            country_code: item.countryCode,
            country_name: item.countryName,
            release_state: item.state,
            confidence: item.confidence,
            play_rating: item.playRating ?? null,
            ratings_count: item.ratingsCount || 0,
            reviews_count: item.reviewsCount || 0,
            rating_histogram: item.histogram || null,
            positive_ratings: item.positiveRatings || 0,
            negative_ratings: item.negativeRatings || 0,
            positive_share: item.positiveShare ?? null,
            negative_share: item.negativeShare ?? null,
            atlas_market_score: item.atlasMarketScore ?? null,
            performance_confidence: item.performanceConfidence || 'none',
            is_paid: item.isPaid === true,
            price: item.price ?? null,
            currency: item.currency || null,
            price_text: item.priceText || null,
            evidence: item.evidence || {}
          }))
        );

        await client.query(
          `INSERT INTO package_country_scan_results (
             scan_id, country_code, country_name, release_state, confidence,
             play_rating, ratings_count, reviews_count, rating_histogram,
             positive_ratings, negative_ratings, positive_share, negative_share,
             atlas_market_score, performance_confidence,
             is_paid, price, currency, price_text, evidence
           )
           SELECT
             $1,
             r.country_code, r.country_name, r.release_state, r.confidence,
             r.play_rating, r.ratings_count, r.reviews_count, r.rating_histogram,
             r.positive_ratings, r.negative_ratings, r.positive_share, r.negative_share,
             r.atlas_market_score, r.performance_confidence,
             r.is_paid, r.price, r.currency, r.price_text, COALESCE(r.evidence, '{}'::jsonb)
           FROM jsonb_to_recordset($2::jsonb) AS r(
             country_code CHAR(2),
             country_name TEXT,
             release_state TEXT,
             confidence TEXT,
             play_rating NUMERIC(4,3),
             ratings_count BIGINT,
             reviews_count BIGINT,
             rating_histogram JSONB,
             positive_ratings BIGINT,
             negative_ratings BIGINT,
             positive_share NUMERIC(6,2),
             negative_share NUMERIC(6,2),
             atlas_market_score NUMERIC(6,2),
             performance_confidence TEXT,
             is_paid BOOLEAN,
             price NUMERIC(12,4),
             currency TEXT,
             price_text TEXT,
             evidence JSONB
           )`,
          [scan.id, payloadJson]
        );
      }

      await client.query(
        `UPDATE package_country_scans
         SET status = 'complete',
             completed_at = now(),
             app_title = COALESCE($2, app_title),
             developer = COALESCE($3, developer),
             live_count = $4,
             preregister_count = $5,
             early_access_count = $6,
             unavailable_count = $7,
             unknown_count = $8,
             error_message = NULL
         WHERE id = $1`,
        [
          scan.id,
          appTitle,
          developer,
          countryResult.counts.live,
          countryResult.counts.pre_register,
          countryResult.counts.early_access,
          countryResult.counts.unavailable,
          countryResult.counts.unknown
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }

    return {
      scanId: Number(scan.id),
      packageName: pkg,
      counts: countryResult.counts
    };
  } catch (err) {
    await pool
      .query(
        `UPDATE package_country_scans
         SET status = 'error', completed_at = now(), error_message = $2
         WHERE id = $1`,
        [scan.id, String(err?.message || err).slice(0, 1000)]
      )
      .catch(() => {});
    throw err;
  }
}

async function processCountryBatchLoop(pool) {
  if (countryBatchQueue.running) return;
  countryBatchQueue.running = true;
  countryBatchQueue.state = 'running';

  try {
    while (countryBatchQueue.pendingPackages.length > 0) {
      if (countryBatchQueue.cancelled) {
        countryBatchQueue.state = 'cancelled';
        countryBatchQueue.running = false;
        countryBatchQueue.finishedAt = new Date().toISOString();
        countryBatchQueue.log = `> 🛑 Country batch scan cancelled. Completed ${countryBatchQueue.completedPackages}/${countryBatchQueue.totalPackages} games.`;
        return;
      }

      if (countryBatchQueue.paused) {
        countryBatchQueue.state = 'paused';
        countryBatchQueue.running = false;
        countryBatchQueue.log = `> ⏸ Country batch scan paused (${countryBatchQueue.completedPackages}/${countryBatchQueue.totalPackages} done, ${countryBatchQueue.pendingPackages.length} remaining).`;
        return;
      }

      const nextItem = countryBatchQueue.pendingPackages.shift();
      if (!nextItem) continue;
      const pkg = nextItem.packageName;
      const title = nextItem.title || pkg;

      countryBatchQueue.currentPackage = pkg;
      countryBatchQueue.currentAppTitle = title;
      countryBatchQueue.currentCountryChecked = 0;
      countryBatchQueue.currentCountryTotal = COUNTRY_CODES.length;
      countryBatchQueue.log = `> 🌍 [${countryBatchQueue.completedPackages + 1}/${countryBatchQueue.totalPackages}] Scanning countries for ${title} (${pkg})...`;

      try {
        const res = await executeAndSaveSingleCountryScan(pool, pkg, (p) => {
          countryBatchQueue.currentCountryChecked = p.checked || 0;
          countryBatchQueue.currentCountryTotal = p.total || COUNTRY_CODES.length;
          countryBatchQueue.currentCountryCode = p.currentCountry || null;
        });
        countryBatchQueue.completedPackages += 1;
        invalidatePlayOverviewCache();
        countryBatchQueue.log = `> ✔ [${countryBatchQueue.completedPackages}/${countryBatchQueue.totalPackages}] ${title}: Live in ${res.counts.live}/${COUNTRY_CODES.length} countries.`;
      } catch (err) {
        countryBatchQueue.completedPackages += 1;
        countryBatchQueue.failedPackages.push({
          packageName: pkg,
          title,
          error: err.message || 'Scan failed'
        });
        countryBatchQueue.log = `> ⚠ [${countryBatchQueue.completedPackages}/${countryBatchQueue.totalPackages}] ${title} failed: ${err.message}`;
      }
    }

    countryBatchQueue.running = false;
    countryBatchQueue.currentPackage = null;
    countryBatchQueue.currentAppTitle = null;
    countryBatchQueue.state = 'complete';
    countryBatchQueue.finishedAt = new Date().toISOString();
    countryBatchQueue.log = `> 🎉 Batch country scan complete! Scanned ${countryBatchQueue.completedPackages} games (${countryBatchQueue.skippedPackages} skipped as fresh, ${countryBatchQueue.failedPackages.length} failed).`;
  } catch (err) {
    countryBatchQueue.running = false;
    countryBatchQueue.state = 'error';
    countryBatchQueue.finishedAt = new Date().toISOString();
    countryBatchQueue.log = `> ❌ Batch country scan error: ${err.message}`;
  }
}

// In-memory TTL cache for /api/play/overview so repeated tab switches and page reloads respond in <5ms
let playOverviewCache = { payload: null, expiresAt: 0 };
function invalidatePlayOverviewCache() {
  playOverviewCache = { payload: null, expiresAt: 0 };
}

function registerPlayStoreRoutes({ app, pool }) {
  // Invalidate overview cache automatically whenever any Play Store mutation runs
  app.use('/api/play', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      res.on('finish', () => invalidatePlayOverviewCache());
    }
    next();
  });
  // 1. Validate Play Store publisher links
  app.post('/api/play/validate', (req, res) => {
    const links = parseInputLinks(req.body?.links || req.body?.urls || '');
    const validation = validatePlayBatch(links);
    const validCount = validation.filter((v) => v.valid && !v.duplicate).length;
    const duplicateCount = validation.filter((v) => v.duplicate).length;
    const invalidCount = validation.filter((v) => !v.valid).length;
    res.json({
      totalSubmitted: validation.length,
      validCount,
      duplicateCount,
      invalidCount,
      validation
    });
  });

  // 2. Full Play Store Intelligence Overview
  app.get('/api/play/overview', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const forceFresh = req.query?.fresh === '1';
      if (!forceFresh && playOverviewCache.payload && playOverviewCache.expiresAt > Date.now()) {
        return res.json(playOverviewCache.payload);
      }

      const [pubsRes, listsRes, membershipsRes, gamesRes, snapsRes, countryLatestRes] = await Promise.all([
        pool.query(`
          SELECT *
          FROM play_publishers
          ORDER BY total_games DESC, total_installs DESC, publisher_name ASC
        `),
        pool.query(`
          SELECT *
          FROM play_lists
          ORDER BY id ASC
        `),
        pool.query(`
          SELECT list_id, publisher_id
          FROM play_list_publishers
        `),
        pool.query(`
          SELECT
            ag.account_id AS publisher_id,
            p.publisher_name,
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
            g.released,
            g.release_date::text AS release_date,
            g.updated,
            g.is_paid,
            g.price,
            g.currency,
            g.price_text,
            g.ad_count,
            g.card_status,
            g.ad_networks,
            g.developer_id,
            g.developer_url,
            g.developer_name,
            g.first_seen_at,
            g.last_seen_at,
            g.store_scanned_at,
            g.installs_scanned_at,
            g.discovery_source
          FROM account_games ag
          JOIN play_publishers p ON p.id = ag.account_id
          JOIN games g ON g.id = ag.game_id
          WHERE COALESCE(g.is_suspended, false) = false
          ORDER BY COALESCE(g.real_installs, g.min_installs, 0) DESC, COALESCE(g.ratings_count, 0) DESC, g.title ASC
        `),
        pool.query(`
          SELECT *
          FROM play_scan_snapshots
          ORDER BY scanned_at DESC
          LIMIT 50
        `),
        pool.query(`
          SELECT DISTINCT ON (package_name)
            id AS scan_id,
            package_name,
            live_count,
            preregister_count,
            early_access_count,
            unavailable_count,
            unknown_count,
            completed_at
          FROM package_country_scans
          WHERE status = 'complete'
          ORDER BY package_name, id DESC
        `)
      ]);

      const countryByPkg = new Map(
        countryLatestRes.rows.map((c) => [
          c.package_name,
          {
            scanId: Number(c.scan_id),
            liveCount: Number(c.live_count) || 0,
            preRegisterCount: Number(c.preregister_count) || 0,
            earlyAccessCount: Number(c.early_access_count) || 0,
            unavailableCount: Number(c.unavailable_count) || 0,
            unknownCount: Number(c.unknown_count) || 0,
            completedAt: c.completed_at
          }
        ])
      );

      const listsById = new Map(listsRes.rows.map((l) => [l.id, { ...l, publisher_ids: [] }]));
      const listIdsByPub = new Map();

      for (const m of membershipsRes.rows) {
        if (listsById.has(m.list_id)) {
          listsById.get(m.list_id).publisher_ids.push(m.publisher_id);
        }
        if (!listIdsByPub.has(m.publisher_id)) listIdsByPub.set(m.publisher_id, []);
        listIdsByPub.get(m.publisher_id).push(m.list_id);
      }

      const publishers = pubsRes.rows.map((p) => {
        const lIds = listIdsByPub.get(p.id) || [];
        return {
          ...p,
          total_games: Number(p.total_games) || 0,
          free_games: Number(p.free_games) || 0,
          paid_games: Number(p.paid_games) || 0,
          total_reviews: Number(p.total_reviews) || 0,
          total_installs: Number(p.total_installs) || 0,
          daily_installs_delta: Number(p.daily_installs_delta) || 0,
          effective_name: p.display_name && p.display_name.trim() ? p.display_name.trim() : p.publisher_name,
          list_ids: lIds
        };
      });

      const pubById = new Map(publishers.map((p) => [p.id, p]));
      const publishersByPkg = new Map();
      const gamesByPubId = new Map();

      for (const g of gamesRes.rows) {
        if (!publishersByPkg.has(g.package_name)) publishersByPkg.set(g.package_name, []);
        const pubArr = publishersByPkg.get(g.package_name);
        if (!pubArr.includes(g.publisher_name)) pubArr.push(g.publisher_name);

        if (!gamesByPubId.has(g.publisher_id)) gamesByPubId.set(g.publisher_id, []);
        gamesByPubId.get(g.publisher_id).push(g);
      }

      const games = gamesRes.rows.map((g) => {
        const isPaid = Boolean(g.is_paid);
        const countrySummary = countryByPkg.get(g.package_name) || null;
        const sharedPubs = publishersByPkg.get(g.package_name) || [g.publisher_name];
        const parsedRel = g.release_date || parseReleaseDateIso(g.released);
        return {
          ...g,
          pricing: isPaid ? 'paid' : 'free',
          price: g.price != null ? Number(g.price) : null,
          rating: g.rating != null ? Number(g.rating) : null,
          review_count: Number(g.ratings_count) || 0,
          real_installs: g.real_installs != null ? Number(g.real_installs) : null,
          min_installs: Number(g.min_installs) || 0,
          installs_delta_1d: Number(g.installs_delta_1d) || 0,
          release_date: parsedRel,
          url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(g.package_name)}`,
          country_scan: countrySummary,
          shared_publisher_count: sharedPubs.length,
          shared_publishers: sharedPubs
        };
      });

      const lists = [...listsById.values()].map((l) => {
        const memberPubs = l.publisher_ids.map((id) => pubById.get(id)).filter(Boolean);
        const seenPkgs = new Map();
        for (const pubId of l.publisher_ids) {
          const pGames = gamesByPubId.get(pubId) || [];
          for (const g of pGames) {
            if (!seenPkgs.has(g.package_name)) seenPkgs.set(g.package_name, g);
          }
        }
        const uniqueListGames = [...seenPkgs.values()];
        const uniqueGamesCount = uniqueListGames.length;
        const uniqueFree = uniqueListGames.filter((g) => !g.is_paid).length;
        const uniquePaid = uniqueListGames.filter((g) => g.is_paid).length;
        const listInstalls = uniqueListGames.reduce(
          (s, g) => s + (Number(g.real_installs ?? g.min_installs) || 0),
          0
        );

        return {
          ...l,
          account_count: memberPubs.length,
          unique_games: uniqueGamesCount,
          total_games: uniqueGamesCount,
          free_games: uniqueFree,
          paid_games: uniquePaid,
          total_installs: listInstalls
        };
      });

      // Deduplicate portfolio-wide summary by package_name
      const uniqueByPkg = new Map();
      for (const g of games) {
        if (!uniqueByPkg.has(g.package_name)) uniqueByPkg.set(g.package_name, g);
      }
      const uniqueGamesArr = [...uniqueByPkg.values()];
      const uniqueGames = uniqueGamesArr.length;
      const freeGames = uniqueGamesArr.filter((g) => g.pricing === 'free').length;
      const paidGames = uniqueGamesArr.filter((g) => g.pricing === 'paid').length;
      const totalInstalls = uniqueGamesArr.reduce(
        (s, g) => s + (Number(g.real_installs ?? g.min_installs) || 0),
        0
      );
      const totalReviews = uniqueGamesArr.reduce((s, g) => s + (Number(g.review_count) || 0), 0);
      const countryScannedGames = uniqueGamesArr.filter((g) => Boolean(g.country_scan)).length;

      // Fetch competitor groups / batches (e.g. 'Bahria' containing Trenzy + Gaminator)
      let competitorGroups = [];
      try {
        const groupsRes = await pool.query(`
          SELECT 
            g.id,
            g.name,
            COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS competitor_ids,
            COALESCE(array_agg(c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS competitor_names
          FROM competitor_groups g
          LEFT JOIN competitor_group_members gm ON g.id = gm.group_id
          LEFT JOIN competitors c ON gm.competitor_id = c.id
          GROUP BY g.id
          ORDER BY g.name ASC
        `);
        competitorGroups = (groupsRes.rows || []).map((row) => {
          const matchedLists = lists.filter((l) => (row.competitor_ids || []).includes(l.competitor_id));
          const pubIdSet = new Set();
          matchedLists.forEach((l) => (l.publisher_ids || []).forEach((pId) => pubIdSet.add(pId)));
          return {
            id: row.id,
            name: row.name,
            competitor_ids: row.competitor_ids || [],
            competitor_names: row.competitor_names || [],
            list_ids: matchedLists.map((l) => l.id),
            publisher_ids: Array.from(pubIdSet),
            account_count: pubIdSet.size
          };
        });
      } catch (_gErr) {
        // Table might not exist yet if not initialized
      }

      const payload = {
        summary: {
          publisherCount: publishers.length,
          listCount: lists.length,
          uniqueGames,
          totalListings: games.length,
          totalGames: uniqueGames,
          freeGames,
          paidGames,
          freeShare: uniqueGames ? freeGames / uniqueGames : 0,
          totalInstalls,
          totalReviews,
          countryScannedGames
        },
        lists,
        competitorGroups,
        publishers,
        games,
        snapshots: snapsRes.rows
      };
      playOverviewCache = {
        payload,
        expiresAt: Date.now() + 90000
      };
      res.json(payload);
    } catch (err) {
      console.error('[Play Overview Error]:', err);
      res.status(500).json({ error: 'Failed to load Play Store intelligence overview.' });
    }
  });

  // 3. Google Sheet 'Competitor Analysis' Preview & One-Way Import
  app.get('/api/play/sheet-preview', async (_req, res) => {
    try {
      const preview = await fetchSheetCompetitorAnalysis(pool);
      res.json(preview);
    } catch (err) {
      console.error('[Play Sheet Preview Error]:', err);
      res.status(500).json({ error: err.message || 'Failed to read Google Sheet Competitor Analysis tab.' });
    }
  });

  app.post('/api/play/sheet-import', async (req, res) => {
    try {
      const preview = await fetchSheetCompetitorAnalysis(pool);
      const selectedLists = Array.isArray(req.body?.listNames) ? new Set(req.body.listNames) : null;
      const autoScanNew = req.body?.autoScanNew === true;

      let listsCreated = 0;
      let publishersCreated = 0;
      let membershipsAdded = 0;
      const newPublisherUrls = [];

      for (const col of preview.columns) {
        if (selectedLists && !selectedLists.has(col.listName)) continue;

        // 1. Ensure list exists in `competitors` and `play_lists`
        let listRes = await pool.query(
          `SELECT id, competitor_id FROM play_lists WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
          [col.listName]
        );
        let listId = listRes.rows[0]?.id || null;
        let competitorId = listRes.rows[0]?.competitor_id || null;

        if (!listId) {
          let compRes = await pool.query(
            `SELECT id FROM competitors WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) OR ($2::text IS NOT NULL AND ads_id = $2) LIMIT 1`,
            [col.listName, col.adsId]
          );
          competitorId = compRes.rows[0]?.id || null;
          if (!competitorId) {
            const insComp = await pool.query(
              `INSERT INTO competitors (name, ads_id, country) VALUES ($1, $2, 'ALL') RETURNING id`,
              [col.listName, col.adsId]
            );
            competitorId = insComp.rows[0].id;
          }

          const insList = await pool.query(
            `INSERT INTO play_lists (name, ads_id, description, competitor_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [
              col.listName,
              col.adsId,
              col.adsId ? `Imported from Google Sheet [${col.adsId}]` : 'Imported from Google Sheet',
              competitorId
            ]
          );
          listId = insList.rows[0].id;
          listsCreated += 1;
        }

        // 2. Ensure each publisher account exists and is linked to `listId`
        for (const acc of col.accounts) {
          let pubRes = await pool.query(
            `SELECT id FROM play_publishers WHERE normalized_name = $1 LIMIT 1`,
            [acc.normalizedKey]
          );
          let pubId = pubRes.rows[0]?.id || null;

          if (!pubId) {
            // Also create in `accounts` so legacy views remain synchronized
            let legacyRes = await pool.query(
              `SELECT id FROM accounts WHERE LOWER(TRIM(publisher_name)) = $1 LIMIT 1`,
              [acc.normalizedKey]
            );
            let legacyAccId = legacyRes.rows[0]?.id || null;
            if (!legacyAccId) {
              const insAcc = await pool.query(
                `INSERT INTO accounts (competitor_id, publisher_name, normalized_name)
                 VALUES ($1, $2, $3)
                 RETURNING id`,
                [competitorId, acc.publisher, acc.publisher.toLowerCase().replace(/[^a-z0-9]/g, '')]
              );
              legacyAccId = insAcc.rows[0].id;
            }

            const insPub = await pool.query(
              `INSERT INTO play_publishers (
                 id, publisher_name, normalized_name, developer_id, source_url, last_scan_status
               ) VALUES ($1, $2, $3, $4, $5, 'unscanned')
               ON CONFLICT (normalized_name) DO UPDATE SET
                 source_url = COALESCE(play_publishers.source_url, EXCLUDED.source_url)
               RETURNING id`,
              [legacyAccId, acc.publisher, acc.normalizedKey, acc.developerId || null, acc.normalizedUrl]
            );
            pubId = insPub.rows[0].id;
            publishersCreated += 1;
            newPublisherUrls.push(acc.normalizedUrl);
          }

          const linkRes = await pool.query(
            `INSERT INTO play_list_publishers (list_id, publisher_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING list_id`,
            [listId, pubId]
          );
          if (linkRes.rowCount > 0) membershipsAdded += 1;
        }
      }

      res.json({
        status: 'imported',
        listsCreated,
        publishersCreated,
        membershipsAdded,
        newPublisherUrls,
        autoScanTriggered: Boolean(autoScanNew && newPublisherUrls.length > 0)
      });
    } catch (err) {
      console.error('[Play Sheet Import Error]:', err);
      res.status(500).json({ error: err.message || 'Failed to import from Google Sheet.' });
    }
  });

  // 4. Play Store Scan Status & Cancel
  app.get('/api/play/scan-status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(playScanStatus);
  });

  app.post('/api/play/cancel-scan', (_req, res) => {
    if (!playScanStatus.running) {
      return res.json({ status: 'idle', message: 'No Play Store scan is currently running.' });
    }
    activePlayScanCancelled = true;
    playScanStatus = {
      ...playScanStatus,
      state: 'cancelling',
      log: '> 🛑 Abort requested. Finishing current publisher and saving all Play Store games collected so far...'
    };
    res.json({ status: 'success', message: 'Abort signal sent.' });
  });

  // 5. Start Play Store Publisher Scan (Single, List, Batch URLs, or "Update All" Daily Scan)
  app.post('/api/play/scan', async (req, res) => {
    if (playScanStatus.running) {
      return res.status(409).json({ error: 'A Play Store publisher scan is already running.' });
    }

    const mode = req.body?.mode || 'batch'; // 'batch' | 'update_all' | 'unscanned_only'
    const forceTelemetry = req.body?.forceTelemetry === true;
    let validTargets = [];

    if (mode === 'update_all' || mode === 'unscanned_only') {
      const whereClause =
        mode === 'unscanned_only' ? `WHERE COALESCE(total_games, 0) = 0 OR last_scan_status = 'unscanned'` : '';
      const pubsRes = await pool.query(
        `SELECT id, publisher_name, source_url, developer_id
         FROM play_publishers
         ${whereClause}
         ORDER BY COALESCE(last_successful_scan_at, '1970-01-01'::timestamptz) ASC, id ASC`
      );
      validTargets = pubsRes.rows
        .map((p) => validatePlayStoreUrl(p.source_url || p.publisher_name))
        .filter((v) => v.valid);
    } else {
      const links = parseInputLinks(req.body?.links || req.body?.urls || '');
      const batch = validatePlayBatch(links);
      validTargets = batch.filter((b) => b.valid && !b.duplicate);
    }

    if (validTargets.length === 0) {
      return res.status(400).json({
        error: 'No valid Play Store publisher links or accounts found to scan.'
      });
    }

    // Resolve target list(s) if requested
    const targetListIds = new Set(
      (Array.isArray(req.body?.listIds) ? req.body.listIds : req.body?.listId ? [req.body.listId] : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    const newListName = String(req.body?.newListName || '').trim();
    let createdList = null;
    if (newListName) {
      try {
        const insComp = await pool.query(
          `INSERT INTO competitors (name, country) VALUES ($1, 'ALL') RETURNING id`,
          [newListName]
        );
        const listRes = await pool.query(
          `INSERT INTO play_lists (name, description, competitor_id) VALUES ($1, $2, $3) RETURNING *`,
          [newListName, req.body?.newListDescription || null, insComp.rows[0]?.id || null]
        );
        createdList = listRes.rows[0];
        if (createdList?.id) targetListIds.add(createdList.id);
      } catch (err) {
        console.error('[Play Scan Create List Error]:', err.message);
      }
    }

    activePlayScanCancelled = false;
    playScanStatus = {
      running: true,
      state: 'scanning',
      phase: 'scanning',
      mode,
      isCancelled: false,
      isComplete: false,
      isError: false,
      currentPublisher: validTargets[0].publisher,
      publisherIndex: 1,
      completedPublishers: 0,
      totalPublishers: validTargets.length,
      gamesFoundInCurrent: 0,
      totalGamesSaved: 0,
      newGamesDiscovered: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultsSummary: [],
      failedLinks: [],
      log: `> 🚀 Starting Play Store catalogue scan for ${validTargets.length} publisher(s)...`
    };

    res.json({
      status: 'initiated',
      mode,
      totalPublishers: validTargets.length,
      createdList,
      targetListIds: [...targetListIds]
    });

    (async () => {
      let savedGamesTotal = 0;
      let newGamesTotal = 0;
      let doneCount = 0;
      const resultsSummary = [];
      const failedLinks = [];

      try {
        for (let i = 0; i < validTargets.length; i++) {
          if (activePlayScanCancelled) break;
          const target = validTargets[i];

          playScanStatus = {
            ...playScanStatus,
            phase: 'scanning',
            currentPublisher: target.publisher,
            publisherIndex: i + 1,
            gamesFoundInCurrent: 0,
            log: `> [${i + 1}/${validTargets.length}] Scanning Google Play catalogue for "${target.publisher}"...`
          };

          const result = await scanAndSavePlayPublisher(pool, target, {
            forceTelemetry,
            isCancelled: () => activePlayScanCancelled,
            onProgress: (p) => {
              playScanStatus = {
                ...playScanStatus,
                phase: p.phase || 'scanning',
                currentPublisher: p.publisher || target.publisher,
                gamesFoundInCurrent: p.found || 0,
                log:
                  p.phase === 'enriching_games'
                    ? `> [${p.publisher}] Enriching Play Store telemetry & release dates (${p.enriched}/${p.totalToEnrich})...`
                    : `> [${p.publisher}] Fetching developer catalogue...`
              };
            }
          });

          doneCount += 1;
          const gamesCount = result.totalGames || 0;
          const newCount = result.addedPackages?.length || 0;
          savedGamesTotal += gamesCount;
          newGamesTotal += newCount;

          resultsSummary.push({
            publisher: result.publisher,
            sourceUrl: result.sourceUrl,
            status: result.status,
            statusDetail: result.statusDetail || null,
            gamesFound: gamesCount,
            newGames: newCount,
            freeGames: result.freeGames || 0,
            paidGames: result.paidGames || 0
          });

          if (result.status === 'error' && gamesCount === 0 && result.sourceUrl) {
            failedLinks.push(result.sourceUrl);
          }

          if (result.publisherId && targetListIds.size > 0) {
            for (const listId of targetListIds) {
              await pool
                .query(
                  `INSERT INTO play_list_publishers (list_id, publisher_id)
                   VALUES ($1, $2)
                   ON CONFLICT DO NOTHING`,
                  [listId, result.publisherId]
                )
                .catch(() => {});
            }
          }

          playScanStatus = {
            ...playScanStatus,
            completedPublishers: doneCount,
            totalGamesSaved: savedGamesTotal,
            newGamesDiscovered: newGamesTotal,
            resultsSummary: [...resultsSummary].slice(-100),
            failedLinks: [...failedLinks],
            log: `> ${result.status === 'complete' ? '✔' : '⚠'} [${doneCount}/${validTargets.length}] ${result.publisher}: ${gamesCount} games (${newCount} newly discovered).`
          };
          invalidatePlayOverviewCache();
        }

        if (activePlayScanCancelled) {
          playScanStatus = {
            ...playScanStatus,
            running: false,
            state: 'cancelled',
            phase: 'cancelled',
            isCancelled: true,
            finishedAt: new Date().toISOString(),
            log: `> 🛑 Scan stopped by user. Synchronized ${savedGamesTotal} games (${newGamesTotal} new) across ${doneCount}/${validTargets.length} publisher(s).`
          };
        } else {
          const failedCount = failedLinks.length;
          playScanStatus = {
            ...playScanStatus,
            running: false,
            state: failedCount === validTargets.length && savedGamesTotal === 0 ? 'error' : 'complete',
            phase: failedCount > 0 ? 'completed_with_warnings' : 'completed',
            isComplete: true,
            isError: failedCount === validTargets.length && savedGamesTotal === 0,
            finishedAt: new Date().toISOString(),
            log:
              failedCount > 0
                ? `> ⚠ Scan finished: ${validTargets.length - failedCount}/${validTargets.length} succeeded (${savedGamesTotal} games, ${newGamesTotal} newly discovered, ${failedCount} failed).`
                : `> 🎉 Play Store scan complete! Synchronized ${savedGamesTotal} games (${newGamesTotal} newly discovered) across ${doneCount} publisher(s).`
          };
        }
      } catch (err) {
        console.error('[Play Batch Scan Error]:', err);
        playScanStatus = {
          ...playScanStatus,
          running: false,
          state: 'error',
          phase: 'failed',
          isError: true,
          finishedAt: new Date().toISOString(),
          log: `> ❌ Play Store scan error: ${err.message}`
        };
      }
    })();
  });

  // 6. Refresh Single Game Telemetry & Metadata (1-Click Game Refresh)
  app.post('/api/play/games/:packageName/refresh', async (req, res) => {
    try {
      const pkg = normalizePackageName(req.params.packageName);
      // Run gplay.app + full telemetry pipeline
      try {
        const appData = await runWithTimeout(
          () => gplay.app({ appId: pkg, country: 'us', lang: 'en' }),
          8000,
          `gplay.app(${pkg})`
        );
        if (appData) {
          const isPaid = appData.free === false && Number(appData.price) > 0;
          const relIso = parseReleaseDateIso(appData.released);
          await pool.query(
            `UPDATE games
             SET title = COALESCE($2, title),
                 category = COALESCE($3, category),
                 rating = COALESCE($4, rating),
                 ratings_count = COALESCE($5, ratings_count),
                 icon = COALESCE($6, icon),
                 header_image = COALESCE($7, header_image),
                 installs = COALESCE($8, installs),
                 min_installs = COALESCE($9, min_installs),
                 released = CASE WHEN $10::text IS NOT NULL AND $10::text <> 'Unknown' THEN $10::text ELSE released END,
                 release_date = COALESCE($11::date, release_date),
                 updated = COALESCE($12, updated),
                 is_paid = $13,
                 price = $14,
                 currency = $15,
                 price_text = $16,
                 last_seen_at = now(),
                 store_scanned_at = now()
             WHERE package_name = $1`,
            [
              pkg,
              appData.title || null,
              appData.genre || null,
              Number(appData.score) || 0,
              Number(appData.ratings) || 0,
              fixUrl(appData.icon),
              fixUrl(appData.headerImage),
              appData.installs || null,
              Number(appData.minInstalls) || 0,
              appData.released || null,
              relIso,
              appData.updated || Date.now(),
              isPaid,
              isPaid ? Number(appData.price) : null,
              isPaid ? appData.currency || 'USD' : null,
              isPaid ? appData.priceText || `$${appData.price}` : 'Free'
            ]
          );
        }
      } catch {}

      const result = await runFullTelemetryForPackage(pool, pkg, { forceRefresh: true });
      res.json({ status: 'refreshed', packageName: pkg, game: result.game });
    } catch (err) {
      console.error('[Play Refresh Game Error]:', err);
      res.status(500).json({ error: err.message || 'Failed to refresh game telemetry.' });
    }
  });

  // 7. Resumable Batch Country Scanner Queue Routes
  app.get('/api/play/country-queue/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      running: countryBatchQueue.running,
      paused: countryBatchQueue.paused,
      cancelled: countryBatchQueue.cancelled,
      state: countryBatchQueue.state,
      scopeLabel: countryBatchQueue.scopeLabel,
      skipDays: countryBatchQueue.skipDays,
      totalPackages: countryBatchQueue.totalPackages,
      completedPackages: countryBatchQueue.completedPackages,
      skippedPackages: countryBatchQueue.skippedPackages,
      remainingPackages: countryBatchQueue.pendingPackages.length,
      failedCount: countryBatchQueue.failedPackages.length,
      failedPackages: countryBatchQueue.failedPackages.slice(-30),
      currentPackage: countryBatchQueue.currentPackage,
      currentAppTitle: countryBatchQueue.currentAppTitle,
      currentCountryChecked: countryBatchQueue.currentCountryChecked,
      currentCountryTotal: countryBatchQueue.currentCountryTotal,
      currentCountryCode: countryBatchQueue.currentCountryCode,
      startedAt: countryBatchQueue.startedAt,
      finishedAt: countryBatchQueue.finishedAt,
      log: countryBatchQueue.log
    });
  });

  app.post('/api/play/country-queue/start', async (req, res) => {
    try {
      if (countryBatchQueue.running) {
        return res.status(409).json({ error: 'A batch country scan is already running.' });
      }

      const scope = req.body?.scope || 'all'; // 'single' | 'publisher' | 'list' | 'all' | 'retry_failed'
      const skipDays = req.body?.skipDays !== undefined ? Math.max(0, Number(req.body.skipDays) || 0) : 7;

      let candidateRows = [];
      let scopeLabel = 'All Games in Atlas';

      if (scope === 'retry_failed') {
        candidateRows = (countryBatchQueue.failedPackages || []).map((f) => ({
          package_name: f.packageName,
          title: f.title
        }));
        scopeLabel = `Retry Failed Games (${candidateRows.length})`;
      } else if (scope === 'single' && req.body?.packageName) {
        const pkg = normalizePackageName(req.body.packageName);
        const gRes = await pool.query(`SELECT package_name, title FROM games WHERE package_name = $1 LIMIT 1`, [pkg]);
        candidateRows = gRes.rows.length > 0 ? gRes.rows : [{ package_name: pkg, title: pkg }];
        scopeLabel = `Game: ${candidateRows[0].title || pkg}`;
      } else if (scope === 'publisher' && req.body?.publisherId) {
        const pubId = Number(req.body.publisherId);
        const pubRes = await pool.query(`SELECT publisher_name FROM play_publishers WHERE id = $1`, [pubId]);
        scopeLabel = `Publisher: ${pubRes.rows[0]?.publisher_name || pubId}`;
        const gRes = await pool.query(
          `SELECT DISTINCT g.package_name, g.title, COALESCE(g.real_installs, g.min_installs, 0) AS sort_installs
           FROM account_games ag
           JOIN games g ON g.id = ag.game_id
           WHERE ag.account_id = $1 AND COALESCE(g.is_suspended, false) = false
           ORDER BY sort_installs DESC`,
          [pubId]
        );
        candidateRows = gRes.rows;
      } else if (scope === 'list' && req.body?.listId) {
        const listId = Number(req.body.listId);
        const lRes = await pool.query(`SELECT name FROM play_lists WHERE id = $1`, [listId]);
        scopeLabel = `List: ${lRes.rows[0]?.name || listId}`;
        const gRes = await pool.query(
          `SELECT DISTINCT g.package_name, g.title, COALESCE(g.real_installs, g.min_installs, 0) AS sort_installs
           FROM play_list_publishers plp
           JOIN account_games ag ON ag.account_id = plp.publisher_id
           JOIN games g ON g.id = ag.game_id
           WHERE plp.list_id = $1 AND COALESCE(g.is_suspended, false) = false
           ORDER BY sort_installs DESC`,
          [listId]
        );
        candidateRows = gRes.rows;
      } else {
        scopeLabel = 'All Games in Atlas';
        const gRes = await pool.query(
          `SELECT DISTINCT package_name, title, COALESCE(real_installs, min_installs, 0) AS sort_installs
           FROM games
           WHERE COALESCE(is_suspended, false) = false
             AND package_name LIKE 'com.%'
           ORDER BY sort_installs DESC`
        );
        candidateRows = gRes.rows;
      }

      // Filter out games already scanned within `skipDays` (unless scope === 'single' or skipDays === 0)
      let skippedCount = 0;
      let queueItems = candidateRows.map((r) => ({
        packageName: r.package_name,
        title: r.title || r.package_name
      }));

      if (skipDays > 0 && scope !== 'single' && scope !== 'retry_failed' && queueItems.length > 0) {
        const recentRes = await pool.query(
          `SELECT DISTINCT package_name
           FROM package_country_scans
           WHERE status = 'complete'
             AND completed_at >= now() - ($1 * INTERVAL '1 day')`,
          [skipDays]
        );
        const recentSet = new Set(recentRes.rows.map((r) => r.package_name));
        const filtered = [];
        for (const item of queueItems) {
          if (recentSet.has(item.packageName)) {
            skippedCount += 1;
          } else {
            filtered.push(item);
          }
        }
        queueItems = filtered;
      }

      if (queueItems.length === 0) {
        return res.json({
          status: 'nothing_to_scan',
          skippedPackages: skippedCount,
          message:
            skippedCount > 0
              ? `All ${skippedCount} game(s) in "${scopeLabel}" were already scanned within the last ${skipDays} days.`
              : `No games found for "${scopeLabel}".`
        });
      }

      countryBatchQueue = {
        running: false,
        paused: false,
        cancelled: false,
        state: 'running',
        scopeLabel,
        skipDays,
        totalPackages: queueItems.length,
        completedPackages: 0,
        skippedPackages: skippedCount,
        failedPackages: [],
        currentPackage: queueItems[0].packageName,
        currentAppTitle: queueItems[0].title,
        currentCountryChecked: 0,
        currentCountryTotal: COUNTRY_CODES.length,
        currentCountryCode: null,
        pendingPackages: queueItems,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: `> 🌍 Queued ${queueItems.length} game(s) for ${scopeLabel} (${skippedCount} skipped as fresh)...`
      };

      void processCountryBatchLoop(pool);

      res.json({
        status: 'started',
        scopeLabel,
        totalPackages: queueItems.length,
        skippedPackages: skippedCount
      });
    } catch (err) {
      console.error('[Play Country Queue Start Error]:', err);
      res.status(500).json({ error: err.message || 'Failed to start country batch queue.' });
    }
  });

  app.post('/api/play/country-queue/control', (req, res) => {
    const action = req.body?.action; // 'pause' | 'resume' | 'cancel'
    if (action === 'pause') {
      countryBatchQueue.paused = true;
      countryBatchQueue.state = 'paused';
      return res.json({ status: 'paused' });
    }
    if (action === 'resume') {
      if (countryBatchQueue.pendingPackages.length === 0) {
        return res.status(400).json({ error: 'No pending packages left to resume.' });
      }
      countryBatchQueue.paused = false;
      countryBatchQueue.cancelled = false;
      void processCountryBatchLoop(pool);
      return res.json({ status: 'resumed' });
    }
    if (action === 'cancel') {
      countryBatchQueue.cancelled = true;
      countryBatchQueue.paused = false;
      countryBatchQueue.pendingPackages = [];
      countryBatchQueue.state = 'cancelled';
      countryBatchQueue.running = false;
      countryBatchQueue.finishedAt = new Date().toISOString();
      return res.json({ status: 'cancelled' });
    }
    res.status(400).json({ error: 'Unsupported action. Use pause, resume, or cancel.' });
  });

  // 8. Publisher & List Management CRUD (identical to Amazon Intelligence)
  app.patch('/api/play/publishers/:id', async (req, res) => {
    try {
      const pubId = Number(req.params.id);
      if (!Number.isInteger(pubId)) return res.status(400).json({ error: 'Invalid publisher ID.' });

      if (req.body?.displayName !== undefined) {
        const cleanDisplay = String(req.body.displayName || '').trim() || null;
        await pool.query(`UPDATE play_publishers SET display_name = $2 WHERE id = $1`, [pubId, cleanDisplay]);
      }

      if (Array.isArray(req.body?.listIds)) {
        const cleanListIds = req.body.listIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        await pool.query(`DELETE FROM play_list_publishers WHERE publisher_id = $1`, [pubId]);
        if (cleanListIds.length > 0) {
          await pool.query(
            `INSERT INTO play_list_publishers (list_id, publisher_id)
             SELECT unnest($1::int[]), $2::int
             ON CONFLICT DO NOTHING`,
            [cleanListIds, pubId]
          );
        }
      }

      res.json({ status: 'updated' });
    } catch (err) {
      console.error('[Play Update Publisher Error]:', err);
      res.status(500).json({ error: 'Failed to update publisher.' });
    }
  });

  app.delete('/api/play/publishers/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM play_publishers WHERE id = $1`, [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete publisher.' });
    }
  });

  app.post('/api/play/lists', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'List name is required.' });
      const description = String(req.body?.description || '').trim() || null;
      const adsId = String(req.body?.adsId || '').trim() || null;

      const listRes = await pool.query(
        `INSERT INTO play_lists (name, ads_id, description) VALUES ($1, $2, $3) RETURNING *`,
        [name, adsId, description]
      );
      const list = listRes.rows[0];

      const pubIds = (Array.isArray(req.body?.publisherIds) ? req.body.publisherIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);

      if (pubIds.length > 0) {
        await pool.query(
          `INSERT INTO play_list_publishers (list_id, publisher_id)
           SELECT $1::int, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [list.id, pubIds]
        );
      }

      res.json({ status: 'created', list });
    } catch (err) {
      console.error('[Play Create List Error]:', err);
      res.status(500).json({ error: 'Failed to create list.' });
    }
  });

  app.patch('/api/play/lists/:id', async (req, res) => {
    try {
      const listId = Number(req.params.id);
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'List name is required.' });
      const description =
        req.body?.description !== undefined ? String(req.body.description || '').trim() || null : undefined;

      const updated = await pool.query(
        `UPDATE play_lists
         SET name = $2,
             description = COALESCE($3, description),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [listId, name, description ?? null]
      );
      res.json({ status: 'updated', list: updated.rows[0] });
    } catch (err) {
      console.error('[Play Rename List Error]:', err);
      res.status(500).json({ error: 'Failed to rename list.' });
    }
  });

  app.delete('/api/play/lists/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM play_lists WHERE id = $1`, [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete list.' });
    }
  });

  app.post('/api/play/lists/:id/publishers', async (req, res) => {
    try {
      const listId = Number(req.params.id);
      const action = req.body?.action || 'add'; // 'add' | 'remove' | 'set'
      const pubIds = (Array.isArray(req.body?.publisherIds) ? req.body.publisherIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);

      if (action === 'set') {
        await pool.query(`DELETE FROM play_list_publishers WHERE list_id = $1`, [listId]);
        if (pubIds.length > 0) {
          await pool.query(
            `INSERT INTO play_list_publishers (list_id, publisher_id)
             SELECT $1::int, unnest($2::int[])
             ON CONFLICT DO NOTHING`,
            [listId, pubIds]
          );
        }
      } else if (action === 'remove' && pubIds.length > 0) {
        await pool.query(
          `DELETE FROM play_list_publishers WHERE list_id = $1 AND publisher_id = ANY($2::int[])`,
          [listId, pubIds]
        );
      } else if (pubIds.length > 0) {
        await pool.query(
          `INSERT INTO play_list_publishers (list_id, publisher_id)
           SELECT $1::int, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [listId, pubIds]
        );
      }

      res.json({ status: 'updated' });
    } catch (err) {
      console.error('[Play List Membership Error]:', err);
      res.status(500).json({ error: 'Failed to update list publishers.' });
    }
  });
}

module.exports = {
  initializePlayStoreStorage,
  syncLegacyAccountsAndCompetitors,
  registerPlayStoreRoutes,
  validatePlayStoreUrl,
  validatePlayBatch,
  scanAndSavePlayPublisher,
  fetchSheetCompetitorAnalysis
};
