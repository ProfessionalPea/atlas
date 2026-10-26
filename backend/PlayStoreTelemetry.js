const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBoundedQueue } = require('./ScannerResilience');

const execFileAsync = promisify(execFile);

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// Top Mobile Ad Networks mapped by their canonical app-ads.txt domains
const KNOWN_AD_NETWORKS = {
  'google.com': 'Admob',
  'applovin.com': 'AppLovin',
  'supersonicads.com': 'ironSource',
  'ironsrc.com': 'ironSource',
  'unity3d.com': 'Unity Ads',
  'unityads.unity3d.com': 'Unity Ads',
  'unity.com': 'Unity Ads',
  'mintegral.com': 'Mintegral',
  'vungle.com': 'Liftoff',
  'liftoff.io': 'Liftoff',
  'inmobi.com': 'InMobi',
  'facebook.com': 'Meta',
  'chartboost.com': 'Chartboost',
  'pangle.cn': 'Pangle',
  'pangleglobal.com': 'Pangle'
};

// Known multi-publisher SSP / mediation aggregators that inject their own
// google.com DIRECT accounts into managed app-ads.txt files (e.g. app-ads-txt.com).
const KNOWN_SSP_AGGREGATOR_DOMAINS = new Set([
  'rtbdemand.com',
  'playstream.media',
  'undrads.com',
  'adsolut.in',
  'pubsfusion.com',
  'bluexad.ai',
  'bidstrade.io',
  'anyclip.com',
  'freestar.com',
  'monetizemore.com',
  'ezoic.com',
  'adapex.io',
  'adpushup.com',
  'setupad.com'
]);

// Genre-benchmarked retention & session defaults (D1 %, D7 %, avg session minutes)
const GENRE_BENCHMARKS = {
  simulation: { d1: 23.0, d7: 4.0, session: 10.0 },
  'pet care': { d1: 23.0, d7: 4.0, session: 10.0 },
  casual: { d1: 26.0, d7: 5.5, session: 11.0 },
  hypercasual: { d1: 28.0, d7: 3.5, session: 8.0 },
  action: { d1: 25.0, d7: 5.0, session: 14.0 },
  arcade: { d1: 24.0, d7: 4.5, session: 9.5 },
  puzzle: { d1: 30.0, d7: 8.0, session: 15.0 },
  strategy: { d1: 29.0, d7: 9.0, session: 22.0 },
  rpg: { d1: 31.0, d7: 10.0, session: 25.0 },
  'role playing': { d1: 31.0, d7: 10.0, session: 25.0 },
  adventure: { d1: 24.0, d7: 5.0, session: 12.0 },
  racing: { d1: 24.0, d7: 4.5, session: 10.5 },
  sports: { d1: 25.0, d7: 5.5, session: 12.0 },
  default: { d1: 23.0, d7: 4.0, session: 10.0 }
};

function getAtPath(obj, pathArr) {
  let cur = obj;
  for (const key of pathArr) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function parseDateSafe(value) {
  if (!value) return null;
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

function extractSubcategoriesFromDs5(ds5Data, title = '', description = '') {
  const tags = [];
  const seen = new Set();
  const addTag = (raw) => {
    const clean = String(raw || '').trim();
    if (!clean || clean.length > 40) return;
    if (/^GAME_|^\/store\/|^\/m\/|^\/genome\//i.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(clean);
  };

  // Primary genre path: data[1][2][79][0][0][0]
  const primaryGenreBlock = getAtPath(ds5Data, [1, 2, 79, 0, 0]);
  if (Array.isArray(primaryGenreBlock) && typeof primaryGenreBlock[0] === 'string') {
    addTag(primaryGenreBlock[0]);
  } else if (typeof primaryGenreBlock === 'string') {
    addTag(primaryGenreBlock);
  }

  // Secondary genre / tag pills: data[1][2][118]
  const tagTree = getAtPath(ds5Data, [1, 2, 118]);
  const walkTags = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string' && Array.isArray(node[1])) {
      addTag(node[0]);
      return;
    }
    for (const child of node) walkTags(child);
  };
  walkTags(tagTree);

  // If Google compacted the listing (no data[1][2][118]), infer secondary subgenre tag from listing text when obvious
  if (tags.length === 1) {
    const text = `${title} ${description}`.toLowerCase();
    if (/\b(pet|doraemon|cat|dog|puppy|kitten|tamagotchi|virtual friend|care)\b/.test(text) && tags[0].toLowerCase() === 'simulation') {
      addTag('Pet Care');
    } else if (/\b(dress up|makeover|fashion|salon)\b/.test(text)) {
      addTag('Dress-up');
    } else if (/\b(tycoon|idle|management)\b/.test(text)) {
      addTag('Tycoon');
    } else if (/\b(merge|match)\b/.test(text)) {
      addTag('Merge');
    }
  }

  return tags;
}

function parsePlayStoreDs5Html(html, packageName = '') {
  if (!html || typeof html !== 'string') return null;

  const match = html.match(/AF_initDataCallback\(\{key:\s*'ds:5',[\s\S]*?data:\s*([\s\S]*?),\s*sideChannel:\s*\{\}\}\);/);
  if (!match) return null;

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const root = getAtPath(data, [1, 2]);
  if (!Array.isArray(root)) return null;

  const title = getAtPath(data, [1, 2, 0, 0]) || null;
  const installsTier = getAtPath(data, [1, 2, 13, 0]) || null;
  const minInstallsRaw = getAtPath(data, [1, 2, 13, 1]);
  const realInstallsRaw = getAtPath(data, [1, 2, 13, 2]);
  const realInstalls = Number.isFinite(Number(realInstallsRaw))
    ? Math.max(0, Math.trunc(Number(realInstallsRaw)))
    : (Number.isFinite(Number(minInstallsRaw)) ? Math.max(0, Math.trunc(Number(minInstallsRaw))) : null);

  // Release date: standard path data[1][2][10][0], or fallback to compacted metadata container data[1][2][103]['146'][0][0] / data[1][2][145][0][0]
  const rawReleaseDate =
    getAtPath(data, [1, 2, 10, 0]) ||
    getAtPath(data, [1, 2, 103, '146', 0, 0]) ||
    getAtPath(data, [1, 2, 145, 0, 0]) ||
    null;
  const releaseDate = parseDateSafe(rawReleaseDate);

  const developerName = getAtPath(data, [1, 2, 68, 0]) || getAtPath(data, [1, 2, 37, 0]) || null;
  const developerWebsite =
    getAtPath(data, [1, 2, 69, 0, 5, 2]) ||
    getAtPath(data, [1, 2, 69, 0, 0, 5, 2]) ||
    null;

  const shortDescription = getAtPath(data, [1, 2, 73, 0, 1]) || '';
  const longDescription = getAtPath(data, [1, 2, 72, 0, 1]) || '';
  const icon = getAtPath(data, [1, 2, 95, 0, 3, 2]) || null;
  const headerImage = getAtPath(data, [1, 2, 96, 0, 3, 2]) || null;
  const ratingRaw = getAtPath(data, [1, 2, 51, 0, 1]);
  const ratingsCountRaw = getAtPath(data, [1, 2, 51, 2, 1]);

  const subcategories = extractSubcategoriesFromDs5(data, title || packageName, `${shortDescription} ${longDescription}`);

  return {
    packageName,
    title,
    installsTier,
    realInstalls,
    releaseDate,
    rawReleaseDate,
    developerName,
    developerWebsite,
    subcategories,
    shortDescription,
    longDescription,
    icon,
    headerImage,
    rating: Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null,
    ratingsCount: Number.isFinite(Number(ratingsCountRaw)) ? Math.trunc(Number(ratingsCountRaw)) : null,
    rawDs5: data
  };
}

async function fetchPlayStoreDs5(packageName, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 12000;
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=US`;
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': options.userAgent || DESKTOP_UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Play Store HTTP ${response.status} for ${packageName}`);
  }

  const html = await response.text();
  const parsed = parsePlayStoreDs5Html(html, packageName);
  if (!parsed) {
    throw new Error(`Could not locate AF_initDataCallback ds:5 block for ${packageName}`);
  }
  return parsed;
}

// ============================================================================
// Step 1: Database Migration & Time-Series Storage
// ============================================================================
async function initializePlayTelemetryStorage(pool) {
  await pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS installs_tier TEXT,
      ADD COLUMN IF NOT EXISTS real_installs BIGINT,
      ADD COLUMN IF NOT EXISTS installs_delta_1d INTEGER,
      ADD COLUMN IF NOT EXISTS installs_avg_daily_7d INTEGER,
      ADD COLUMN IF NOT EXISTS installs_total_7d INTEGER,
      ADD COLUMN IF NOT EXISTS estimated_dau INTEGER,
      ADD COLUMN IF NOT EXISTS retention_d1 DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS retention_d7 DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS avg_session_minutes DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rev_monthly_min DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rev_monthly_max DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS rev_confidence TEXT,
      ADD COLUMN IF NOT EXISTS subcategories JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS release_date DATE,
      ADD COLUMN IF NOT EXISTS card_status TEXT DEFAULT 'unscanned',
      ADD COLUMN IF NOT EXISTS ad_networks JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS ad_networks_all JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS network_data JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS developer_name TEXT,
      ADD COLUMN IF NOT EXISTS developer_website TEXT,
      ADD COLUMN IF NOT EXISTS advertiser_legal_name TEXT,
      ADD COLUMN IF NOT EXISTS store_scanned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS installs_scanned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS networks_scanned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS card_scanned_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS app_install_history (
      id BIGSERIAL PRIMARY KEY,
      package_name TEXT NOT NULL,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      real_installs BIGINT NOT NULL,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (package_name, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_app_install_history_pkg_date
      ON app_install_history(package_name, snapshot_date DESC);

    CREATE TABLE IF NOT EXISTS google_sellers_cache (
      seller_id TEXT PRIMARY KEY,
      name TEXT,
      domain TEXT,
      seller_type TEXT,
      is_confidential BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ============================================================================
// Step 2: Pipeline 1 — Exact Install Counter (ds:5) & Velocity Engine
// ============================================================================
function computeVelocityMetrics({ todayInstalls, historyRows = [], releaseDate = null, fallbackInstallsTier = null }) {
  const realInstalls = Number(todayInstalls);
  if (!Number.isFinite(realInstalls) || realInstalls < 0) {
    return {
      realInstalls: 0,
      installsDelta1d: 0,
      installsTotal7d: 0,
      installsAvgDaily7d: 0,
      sparkline: []
    };
  }

  const normalized = historyRows
    .map(row => ({
      date: parseDateSafe(row.snapshot_date || row.date),
      realInstalls: Number(row.real_installs ?? row.realInstalls ?? 0),
      dailyDelta: Number(row.daily_delta ?? row.dailyDelta ?? 0)
    }))
    .filter(row => row.date && Number.isFinite(row.realInstalls))
    .sort((a, b) => a.date.localeCompare(b.date));

  const todayIso = new Date().toISOString().slice(0, 10);
  const previousSnapshots = normalized.filter(r => r.date < todayIso);

  let installsDelta1d = 0;
  let installsTotal7d = 0;
  let installsAvgDaily7d = 0;

  if (previousSnapshots.length > 0) {
    const yesterdayRow = previousSnapshots[previousSnapshots.length - 1];
    installsDelta1d = Math.max(0, Math.round(realInstalls - yesterdayRow.realInstalls));

    const target7dDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const rowAtOrBefore7d = [...previousSnapshots].reverse().find(r => r.date <= target7dDate);
    const anchorRow = rowAtOrBefore7d || previousSnapshots[0];
    const anchorMs = new Date(anchorRow.date + 'T00:00:00Z').getTime();
    const todayMs = new Date(todayIso + 'T00:00:00Z').getTime();
    const elapsedDays = Math.max(1, Math.min(7, Math.round((todayMs - anchorMs) / 86400000)));

    installsTotal7d = Math.max(0, Math.round(realInstalls - anchorRow.realInstalls));
    installsAvgDaily7d = Math.round(installsTotal7d / elapsedDays);
  } else {
    const tierFloor = fallbackInstallsTier
      ? Number(String(fallbackInstallsTier).replace(/[^0-9]/g, '')) || 0
      : 0;
    const excessAboveFloor = tierFloor > 0 && realInstalls > tierFloor
      ? realInstalls - tierFloor
      : realInstalls;

    let elapsedReleaseDays = 7;
    const parsedRel = parseDateSafe(releaseDate);
    if (parsedRel) {
      const diff = Math.round((Date.now() - new Date(parsedRel + 'T00:00:00Z').getTime()) / 86400000);
      if (diff >= 1 && diff < 7) elapsedReleaseDays = diff;
    }

    if (excessAboveFloor > 0) {
      installsTotal7d = Math.round(excessAboveFloor);
      installsAvgDaily7d = Math.round(installsTotal7d / elapsedReleaseDays);
      installsDelta1d = Math.round(installsAvgDaily7d * 1.25);
    }
  }

  return {
    realInstalls,
    installsDelta1d,
    installsTotal7d,
    installsAvgDaily7d
  };
}

async function runInstallVelocityPipeline(pool, packageName, prefetchedDs5 = null) {
  const ds5 = prefetchedDs5 || await fetchPlayStoreDs5(packageName);
  const realInstalls = Number(ds5.realInstalls ?? 0);

  const { rows: existingHistory } = await pool.query(
    `SELECT snapshot_date::text AS snapshot_date, real_installs, daily_delta
     FROM app_install_history
     WHERE package_name = $1
     ORDER BY snapshot_date ASC
     LIMIT 35`,
    [packageName]
  );

  const { rows: existingGameRows } = await pool.query(
    `SELECT id, released, release_date FROM games WHERE package_name = $1 LIMIT 1`,
    [packageName]
  );
  const existingGame = existingGameRows[0] || null;
  const effectiveReleaseDate =
    ds5.releaseDate ||
    parseDateSafe(existingGame?.release_date) ||
    parseDateSafe(existingGame?.released) ||
    null;

  const velocity = computeVelocityMetrics({
    todayInstalls: realInstalls,
    historyRows: existingHistory,
    releaseDate: effectiveReleaseDate,
    fallbackInstallsTier: ds5.installsTier
  });

  await pool.query(
    `INSERT INTO app_install_history (package_name, snapshot_date, real_installs, daily_delta)
     VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (package_name, snapshot_date)
     DO UPDATE SET
       real_installs = EXCLUDED.real_installs,
       daily_delta = EXCLUDED.daily_delta`,
    [packageName, velocity.realInstalls, velocity.installsDelta1d]
  );

  if (existingHistory.length <= 1 && velocity.installsTotal7d > 0 && velocity.realInstalls > velocity.installsTotal7d) {
    const startInstalls = velocity.realInstalls - velocity.installsTotal7d;
    const weights = [0.10, 0.12, 0.13, 0.14, 0.16, 0.16, 0.19];
    let cumulative = startInstalls;
    for (let i = 0; i < 7; i++) {
      const daysAgo = 7 - i;
      const stepDelta = i === 6
        ? velocity.installsDelta1d
        : Math.round(velocity.installsTotal7d * weights[i]);
      cumulative = i === 6 ? velocity.realInstalls : Math.min(velocity.realInstalls, cumulative + stepDelta);
      await pool.query(
        `INSERT INTO app_install_history (package_name, snapshot_date, real_installs, daily_delta)
         VALUES ($1, CURRENT_DATE - ($2 * INTERVAL '1 day'), $3, $4)
         ON CONFLICT (package_name, snapshot_date) DO NOTHING`,
        [packageName, daysAgo, cumulative, stepDelta]
      );
    }
  }

  await pool.query(
    `UPDATE games
     SET installs_tier = COALESCE($2, installs_tier, installs),
         installs = COALESCE($2, installs),
         real_installs = $3,
         installs_delta_1d = $4,
         installs_avg_daily_7d = $5,
         installs_total_7d = $6,
         subcategories = CASE WHEN jsonb_array_length($7::jsonb) > 0 THEN $7::jsonb ELSE COALESCE(subcategories, '[]'::jsonb) END,
         release_date = COALESCE($8::date, release_date),
         released = CASE
           WHEN (released IS NULL OR released = '' OR released = 'Unknown') AND $11::text IS NOT NULL THEN $11::text
           ELSE released
         END,
         short_description = COALESCE(NULLIF(short_description, ''), NULLIF($12::text, '')),
         description = CASE
           WHEN (description IS NULL OR description = '' OR description = 'Captured directly via ad stream')
             AND NULLIF($13::text, '') IS NOT NULL THEN $13::text
           ELSE description
         END,
         developer_name = COALESCE($9, developer_name),
         developer_website = COALESCE($10, developer_website),
         store_scanned_at = now(),
         installs_scanned_at = now()
     WHERE package_name = $1`,
    [
      packageName,
      ds5.installsTier,
      velocity.realInstalls,
      velocity.installsDelta1d,
      velocity.installsAvgDaily7d,
      velocity.installsTotal7d,
      JSON.stringify(ds5.subcategories || []),
      effectiveReleaseDate,
      ds5.developerName,
      ds5.developerWebsite,
      ds5.rawReleaseDate || effectiveReleaseDate || null,
      ds5.shortDescription || null,
      ds5.longDescription || null
    ]
  );

  const { rows: updatedHistory } = await pool.query(
    `SELECT snapshot_date::text AS snapshot_date, real_installs, daily_delta
     FROM app_install_history
     WHERE package_name = $1
     ORDER BY snapshot_date ASC
     LIMIT 14`,
    [packageName]
  );

  return {
    ds5,
    velocity,
    releaseDate: effectiveReleaseDate,
    installHistory: updatedHistory.map(r => ({
      date: r.snapshot_date,
      realInstalls: Number(r.real_installs),
      dailyDelta: Number(r.daily_delta)
    }))
  };
}

// ============================================================================
// Step 3: Pipeline 2 — Dynamic Ad Network Share & Legal Advertiser Unmasker
// ============================================================================
function computeProportionalShareMap(countsByNetwork) {
  const entries = Object.entries(countsByNetwork || {})
    .map(([name, count]) => [name, Number(count) || 0])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return {};
  if (entries.length === 1) return { [entries[0][0]]: 100 };

  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const shareMap = {};
  let allocated = 0;

  entries.forEach(([name, count], idx) => {
    if (idx === entries.length - 1) {
      shareMap[name] = Math.max(1, 100 - allocated);
    } else {
      const pct = Math.max(1, Math.round((count / total) * 100));
      shareMap[name] = pct;
      allocated += pct;
    }
  });

  return shareMap;
}

function parseAppAdsTxtContent(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      adNetworks: {},
      adNetworksAll: {},
      directCounts: {},
      resellerCounts: {},
      googleDirectPubIds: [],
      allDirectEntries: []
    };
  }

  const directEntries = [];
  const directKnownCounts = {};
  const resellerKnownCounts = {};
  const combinedWeightedCounts = {};
  const googleDirectPubIdSet = new Set();

  // Deduplicate identical (domain, publisherId, relationship) lines
  const seenTriples = new Set();

  for (const rawLine of rawText.split(/\r?\n/)) {
    const withoutComment = rawLine.split('#')[0].trim();
    if (!withoutComment) continue;
    const parts = withoutComment.split(',').map(s => s.trim());
    if (parts.length < 3) continue;

    const domain = parts[0].toLowerCase();
    const publisherId = parts[1];
    const relationship = parts[2].toUpperCase();
    const certId = parts[3] || null;

    if (relationship !== 'DIRECT' && relationship !== 'RESELLER') continue;
    if (!domain || !publisherId) continue;

    const tripleKey = `${domain}|${publisherId.toLowerCase()}|${relationship}`;
    if (seenTriples.has(tripleKey)) continue;
    seenTriples.add(tripleKey);

    if (relationship === 'DIRECT') {
      directEntries.push({ domain, publisherId, relationship, certId });
      if (domain === 'google.com' || domain.endsWith('.google.com')) {
        googleDirectPubIdSet.add(publisherId);
      }
    }

    const mappedName = KNOWN_AD_NETWORKS[domain];
    if (mappedName) {
      if (relationship === 'DIRECT') {
        directKnownCounts[mappedName] = (directKnownCounts[mappedName] || 0) + 1;
        combinedWeightedCounts[mappedName] = (combinedWeightedCounts[mappedName] || 0) + 3;
      } else {
        resellerKnownCounts[mappedName] = (resellerKnownCounts[mappedName] || 0) + 1;
        combinedWeightedCounts[mappedName] = (combinedWeightedCounts[mappedName] || 0) + 1;
      }
    }
  }

  // Compute dynamic proportional share across the Top Mobile Ad Networks:
  // Prefer DIRECT lines among the major mobile ad networks; if none are marked DIRECT,
  // fall back to DIRECT + RESELLER weighted counts.
  const hasDirectKnown = Object.keys(directKnownCounts).length > 0;
  const adNetworks = hasDirectKnown
    ? computeProportionalShareMap(directKnownCounts)
    : computeProportionalShareMap(combinedWeightedCounts);

  const adNetworksAll = computeProportionalShareMap(combinedWeightedCounts);

  return {
    adNetworks,
    adNetworksAll,
    directCounts: directKnownCounts,
    resellerCounts: resellerKnownCounts,
    googleDirectPubIds: [...googleDirectPubIdSet],
    allDirectEntries: directEntries
  };
}

async function fetchAndParseAppAdsTxt(developerWebsite, timeoutMs = 10000) {
  if (!developerWebsite || typeof developerWebsite !== 'string') {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(developerWebsite.startsWith('http') ? developerWebsite : `https://${developerWebsite}`);
  } catch {
    return null;
  }

  const candidateUrls = [
    `https://${parsedUrl.hostname}/app-ads.txt`,
    `http://${parsedUrl.hostname}/app-ads.txt`
  ];

  // If subdomain (e.g. help.supercellsupport.com), also try root domain
  const hostParts = parsedUrl.hostname.split('.');
  if (hostParts.length > 2) {
    const rootDomain = hostParts.slice(-2).join('.');
    candidateUrls.push(`https://${rootDomain}/app-ads.txt`);
  }

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': DESKTOP_UA,
          'accept': 'text/plain,*/*;q=0.8'
        }
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.length < 10 || /<html|<body|<!doctype/i.test(text.slice(0, 200))) continue;
      const parsed = parseAppAdsTxtContent(text);
      return { ...parsed, sourceUrl: res.url || url };
    } catch {
      // Try next candidate
    }
  }

  return null;
}

// Fallback when app-ads.txt is missing or 404: inspect creative domains / video links
// in ad_video_links + video_assets, or return {} so UI shows "Unknown Network" rather than fake Admob 100%.
async function inferNetworksFromCreativeLinks(pool, packageName) {
  try {
    const { rows } = await pool.query(
      `SELECT va.source, va.media_url, va.youtube_url, avl.creative_url
       FROM ad_video_links avl
       LEFT JOIN video_assets va ON va.id = avl.asset_id
       WHERE avl.package_name = $1
       LIMIT 50`,
      [packageName]
    );
    if (!rows || rows.length === 0) return {};

    const counts = {};
    for (const row of rows) {
      const blob = `${row.source || ''} ${row.media_url || ''} ${row.youtube_url || ''} ${row.creative_url || ''}`.toLowerCase();
      if (blob.includes('applovin')) counts.AppLovin = (counts.AppLovin || 0) + 1;
      else if (blob.includes('unity')) counts['Unity Ads'] = (counts['Unity Ads'] || 0) + 1;
      else if (blob.includes('ironsrc') || blob.includes('supersonic')) counts.ironSource = (counts.ironSource || 0) + 1;
      else if (blob.includes('vungle') || blob.includes('liftoff')) counts.Liftoff = (counts.Liftoff || 0) + 1;
      else if (blob.includes('mintegral')) counts.Mintegral = (counts.Mintegral || 0) + 1;
      else if (blob.includes('inmobi')) counts.InMobi = (counts.InMobi || 0) + 1;
      else if (blob.includes('facebook') || blob.includes('fbcdn')) counts.Meta = (counts.Meta || 0) + 1;
      else if (blob.includes('adstransparency.google.com') || blob.includes('googlesyndication') || blob.includes('doubleclick') || blob.includes('youtube')) {
        counts.Admob = (counts.Admob || 0) + 1;
      }
    }
    return computeProportionalShareMap(counts);
  } catch {
    return {};
  }
}

// Stream Google's sellers.json dictionary and look up target seller_ids (and cache them in PostgreSQL)
async function lookupGoogleSellersJson(pool, pubIds = [], options = {}) {
  const cleanIds = [...new Set(pubIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (cleanIds.length === 0) return [];

  const { rows: cachedRows } = await pool.query(
    `SELECT seller_id, name, domain, seller_type, is_confidential, updated_at
     FROM google_sellers_cache
     WHERE seller_id = ANY($1::text[])
       AND updated_at > now() - INTERVAL '7 days'`,
    [cleanIds]
  );

  const cachedById = new Map(cachedRows.map(r => [r.seller_id.toLowerCase(), r]));
  const missingIds = cleanIds.filter(id => !cachedById.has(id.toLowerCase()));

  if (missingIds.length > 0 && options.allowRemoteFetch !== false) {
    const wantSet = new Set(missingIds.map(id => id.toLowerCase()));
    const timeoutMs = Number(options.timeoutMs) || 120000;
    try {
      const res = await fetch('https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json', {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': DESKTOP_UA }
      });
      if (res.ok && res.body) {
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let startIdx;
          while ((startIdx = buf.indexOf('{', 1)) !== -1) {
            const endIdx = buf.indexOf('}', startIdx);
            if (endIdx === -1) break;
            const jsonSlice = buf.slice(startIdx, endIdx + 1);
            buf = buf.slice(endIdx + 1);
            if (!jsonSlice.includes('pub-')) continue;
            try {
              const obj = JSON.parse(jsonSlice);
              const sid = String(obj.seller_id || '').toLowerCase();
              if (sid && wantSet.has(sid)) {
                const record = {
                  seller_id: String(obj.seller_id),
                  name: obj.name ? String(obj.name).trim() : null,
                  domain: obj.domain ? String(obj.domain).trim().toLowerCase() : null,
                  seller_type: obj.seller_type ? String(obj.seller_type).toUpperCase() : null,
                  is_confidential: Boolean(obj.is_confidential)
                };
                cachedById.set(sid, record);
                wantSet.delete(sid);
                await pool.query(
                  `INSERT INTO google_sellers_cache (seller_id, name, domain, seller_type, is_confidential, updated_at)
                   VALUES ($1, $2, $3, $4, $5, now())
                   ON CONFLICT (seller_id) DO UPDATE SET
                     name = EXCLUDED.name,
                     domain = EXCLUDED.domain,
                     seller_type = EXCLUDED.seller_type,
                     is_confidential = EXCLUDED.is_confidential,
                     updated_at = now()`,
                  [record.seller_id, record.name, record.domain, record.seller_type, record.is_confidential]
                );
                if (wantSet.size === 0) break;
              }
            } catch {
              // Ignore malformed slice
            }
          }
          if (wantSet.size === 0) {
            try { await res.body.cancel(); } catch {}
            break;
          }
        }

        // Persist any pub IDs that were not present in sellers.json as negative cache
        // entries so future lookups within the 7-day window do not re-stream 107MB.
        for (const missingLower of wantSet) {
          const origId = missingIds.find(id => id.toLowerCase() === missingLower) || missingLower;
          await pool.query(
            `INSERT INTO google_sellers_cache (seller_id, name, domain, seller_type, is_confidential, updated_at)
             VALUES ($1, NULL, NULL, 'UNLISTED', TRUE, now())
             ON CONFLICT (seller_id) DO UPDATE SET updated_at = now()`,
            [origId]
          );
        }
      }
    } catch (error) {
      console.warn('[PlayTelemetry] sellers.json stream lookup warning:', error.message);
    }
  }

  return cleanIds.map(id => cachedById.get(id.toLowerCase())).filter(Boolean);
}

function selectPrimaryStudioSeller(sellers = [], developerName = '') {
  const valid = sellers.filter(s => s && !s.is_confidential && s.name && s.name.trim());
  if (valid.length === 0) return null;

  const nonAggregatorPublishers = valid.filter(s => {
    const dom = String(s.domain || '').toLowerCase();
    if (dom && KNOWN_SSP_AGGREGATOR_DOMAINS.has(dom)) return false;
    return s.seller_type === 'PUBLISHER';
  });

  if (nonAggregatorPublishers.length > 0) {
    const devLower = String(developerName || '').toLowerCase();
    const exactMatch = nonAggregatorPublishers.find(s => devLower && s.name.toLowerCase().includes(devLower));
    if (exactMatch) return exactMatch;
    const withoutSspDomain = nonAggregatorPublishers.find(s => !s.domain);
    return withoutSspDomain || nonAggregatorPublishers[0];
  }

  const nonAggregators = valid.filter(s => !KNOWN_SSP_AGGREGATOR_DOMAINS.has(String(s.domain || '').toLowerCase()));
  return nonAggregators[0] || valid[0];
}

async function queryAdsTransparencySuggestions(queryText, timeoutMs = 8000) {
  const cleanQuery = String(queryText || '').trim();
  if (!cleanQuery) return null;

  const body = new URLSearchParams({
    'f.req': JSON.stringify({ 1: cleanQuery, 2: 10, 3: 10 })
  });

  try {
    const res = await fetch('https://adstransparency.google.com/anji/_/rpc/SearchService/SearchSuggestions?authuser=0', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': DESKTOP_UA,
        'origin': 'https://adstransparency.google.com',
        'referer': 'https://adstransparency.google.com/?region=any'
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    const json = JSON.parse(text);
    const items = Array.isArray(json?.['1']) ? json['1'] : [];
    for (const item of items) {
      const adv = item?.['1'];
      if (adv && typeof adv['1'] === 'string' && adv['1'].trim()) {
        return {
          legalName: adv['1'].trim(),
          advertiserId: adv['2'] || null,
          country: adv['3'] || null
        };
      }
    }
  } catch {
    // Ignore RPC error
  }
  return null;
}

async function resolveAdvertiserLegalName(pool, { packageName, developerName, googleDirectPubIds = [], allowRemoteSellersFetch = false, skipSuggestionsRpc = false }) {
  let candidateFromSellers = null;
  if (googleDirectPubIds.length > 0) {
    const sellers = await lookupGoogleSellersJson(pool, googleDirectPubIds, {
      allowRemoteFetch: Boolean(allowRemoteSellersFetch),
      timeoutMs: 8000
    });
    const chosen = selectPrimaryStudioSeller(sellers, developerName);
    if (chosen?.name) {
      candidateFromSellers = chosen.name.trim();
    }
  }

  if (!skipSuggestionsRpc) {
    const rpcQueries = [
      packageName,
      candidateFromSellers,
      candidateFromSellers ? candidateFromSellers.replace(/\b(pvt|ltd|limited|private|inc|llc)\b\.?/gi, '').trim() : null,
      developerName
    ].filter(Boolean);

    for (const q of rpcQueries) {
      const suggestion = await queryAdsTransparencySuggestions(q);
      if (suggestion?.legalName) {
        return suggestion.legalName;
      }
    }
  }

  if (candidateFromSellers) {
    return candidateFromSellers.toUpperCase();
  }

  if (packageName) {
    const { rows } = await pool.query(
      `SELECT c.name
       FROM games g
       JOIN account_games ag ON ag.game_id = g.id
       JOIN accounts a ON a.id = ag.account_id
       JOIN competitors c ON c.id = a.competitor_id
       WHERE g.package_name = $1
       LIMIT 1`,
      [packageName]
    );
    if (rows[0]?.name) return rows[0].name;
  }

  return null;
}

async function runNetworkAdvertiserPipeline(pool, packageName, options = {}) {
  let developerWebsite = options.developerWebsite || null;
  let developerName = options.developerName || null;

  const { rows: existingRows } = await pool.query(
    `SELECT developer_website, developer_name, ad_networks, ad_networks_all, network_data, advertiser_legal_name, networks_scanned_at
     FROM games WHERE package_name = $1 LIMIT 1`,
    [packageName]
  );
  const existing = existingRows[0] || {};

  // Use 7-day cached network_data unless forceRefresh is requested
  if (
    !options.forceRefresh &&
    existing.networks_scanned_at &&
    existing.network_data &&
    typeof existing.network_data === 'object' &&
    existing.network_data.verified === true &&
    Date.now() - new Date(existing.networks_scanned_at).getTime() < 7 * 86400000
  ) {
    return {
      adNetworks: existing.ad_networks || {},
      adNetworksAll: existing.ad_networks_all || {},
      networkData: existing.network_data,
      advertiserLegalName: existing.advertiser_legal_name || null,
      developerName: existing.developer_name || developerName,
      developerWebsite: existing.developer_website || developerWebsite,
      cached: true
    };
  }

  developerWebsite = developerWebsite || existing.developer_website || null;
  developerName = developerName || existing.developer_name || null;

  if (!developerWebsite) {
    try {
      const ds5 = await fetchPlayStoreDs5(packageName);
      developerWebsite = ds5.developerWebsite;
      developerName = developerName || ds5.developerName;
    } catch {}
  }

  const adsTxtResult = await fetchAndParseAppAdsTxt(developerWebsite, 4500);
  let adNetworks = adsTxtResult?.adNetworks || {};
  let adNetworksAll = adsTxtResult?.adNetworksAll || {};
  const googleDirectPubIds = adsTxtResult?.googleDirectPubIds || [];
  let sourceType = adsTxtResult ? 'app-ads.txt' : 'unverified';

  // If app-ads.txt could not be fetched or had no major networks, fall back to creative domain inspection
  if (Object.keys(adNetworks).length === 0) {
    const inferred = await inferNetworksFromCreativeLinks(pool, packageName);
    if (Object.keys(inferred).length > 0) {
      adNetworks = inferred;
      adNetworksAll = inferred;
      sourceType = 'creative_domain_inspection';
    }
  }

  const advertiserLegalName = await resolveAdvertiserLegalName(pool, {
    packageName,
    developerName,
    googleDirectPubIds,
    allowRemoteSellersFetch: Boolean(options.allowRemoteSellersFetch),
    skipSuggestionsRpc: Boolean(options.skipSuggestionsRpc)
  });

  const networkData = {
    verified: Object.keys(adNetworks).length > 0,
    source: sourceType,
    appAdsUrl: adsTxtResult?.sourceUrl || null,
    directCounts: adsTxtResult?.directCounts || {},
    resellerCounts: adsTxtResult?.resellerCounts || {},
    adNetworks,
    adNetworksAll,
    scannedAt: new Date().toISOString()
  };

  await pool.query(
    `UPDATE games
     SET ad_networks = $2::jsonb,
         ad_networks_all = $3::jsonb,
         network_data = $4::jsonb,
         advertiser_legal_name = COALESCE($5, advertiser_legal_name),
         developer_name = COALESCE($6, developer_name),
         developer_website = COALESCE($7, developer_website),
         networks_scanned_at = now()
     WHERE package_name = $1`,
    [
      packageName,
      JSON.stringify(adNetworks),
      JSON.stringify(adNetworksAll),
      JSON.stringify(networkData),
      advertiserLegalName,
      developerName,
      developerWebsite
    ]
  );

  return {
    adNetworks,
    adNetworksAll,
    networkData,
    advertiserLegalName,
    developerName,
    developerWebsite,
    googleDirectPubIds,
    appAdsUrl: adsTxtResult?.sourceUrl || null
  };
}

// ============================================================================
// Step 4: Pipeline 3 — Live Ad-Signal Card Status ('active' | 'closed' | 'unscanned')
// ============================================================================
function evaluateCardStatusFromAdSignals({
  latestCreativeSeen = null,
  totalCreatives = 0,
  adCount = null,
  hasCompetitorLink = false,
  nowMs = Date.now()
}) {
  const FOURTEEN_DAYS_MS = 14 * 86400000;
  const parsedLatest = latestCreativeSeen ? new Date(latestCreativeSeen) : null;
  const hasValidLatest = parsedLatest && !Number.isNaN(parsedLatest.getTime());

  if (hasValidLatest) {
    const ageMs = nowMs - parsedLatest.getTime();
    if (ageMs <= FOURTEEN_DAYS_MS) {
      return {
        cardStatus: 'active',
        cardScannedAt: parsedLatest.toISOString(),
        reason: 'creative_seen_within_14d'
      };
    }
    return {
      cardStatus: 'closed',
      cardScannedAt: parsedLatest.toISOString(),
      reason: 'creative_older_than_14d'
    };
  }

  const numericAdCount = Number(adCount);
  if (Number.isFinite(numericAdCount) && numericAdCount > 0) {
    return {
      cardStatus: 'active',
      cardScannedAt: new Date(nowMs).toISOString(),
      reason: 'active_ad_count'
    };
  }

  if (hasCompetitorLink && Number.isFinite(numericAdCount) && numericAdCount === 0) {
    return {
      cardStatus: 'closed',
      cardScannedAt: new Date(nowMs).toISOString(),
      reason: 'competitor_scan_zero_creatives'
    };
  }

  return {
    cardStatus: 'unscanned',
    cardScannedAt: null,
    reason: 'no_ad_scan_history'
  };
}

async function runCardStatusPipeline(pool, packageName) {
  const { rows: gameRows } = await pool.query(
    `SELECT g.id, g.ad_count,
            EXISTS(SELECT 1 FROM account_games ag WHERE ag.game_id = g.id) AS has_competitor_link
     FROM games g
     WHERE g.package_name = $1
     LIMIT 1`,
    [packageName]
  );
  const game = gameRows[0] || null;
  const gameId = game?.id || null;

  const { rows: creativeRows } = await pool.query(
    `SELECT MAX(last_seen_at) AS latest_creative_seen, COUNT(*)::int AS total_creatives
     FROM ad_creatives
     WHERE package_name = $1 OR ($2::int IS NOT NULL AND game_id = $2::int)`,
    [packageName, gameId]
  );

  const latestCreativeSeen = creativeRows[0]?.latest_creative_seen || null;
  const totalCreatives = Number(creativeRows[0]?.total_creatives || 0);

  const evaluated = evaluateCardStatusFromAdSignals({
    latestCreativeSeen,
    totalCreatives,
    adCount: game?.ad_count ?? null,
    hasCompetitorLink: Boolean(game?.has_competitor_link)
  });

  await pool.query(
    `UPDATE games
     SET card_status = $2,
         card_scanned_at = COALESCE($3::timestamptz, card_scanned_at)
     WHERE package_name = $1`,
    [packageName, evaluated.cardStatus, evaluated.cardScannedAt]
  );

  return {
    ...evaluated,
    latestCreativeSeen: latestCreativeSeen ? new Date(latestCreativeSeen).toISOString() : null,
    totalCreatives
  };
}

// ============================================================================
// Step 5: Pipeline 4 — DAU, Retention, Session Time & SS rev Estimator
// ============================================================================
class EngagementDataProvider {
  async getEngagementMetrics(packageName) {
    const providerUrl = String(process.env.ATLAS_ENGAGEMENT_PANEL_URL || '').trim();
    const apiKey = String(
      process.env.ATLAS_SENSORTOWER_API_KEY ||
      process.env.ATLAS_SIMILARWEB_API_KEY ||
      process.env.ATLAS_DATA_AI_API_KEY ||
      ''
    ).trim();

    if (!providerUrl || !apiKey) return null;

    try {
      const url = new URL(providerUrl);
      url.searchParams.set('package_name', packageName);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) return null;
      const payload = await res.json();
      if (!payload || !Number.isFinite(Number(payload.dau))) return null;
      return {
        estimatedDau: Math.max(0, Math.round(Number(payload.dau))),
        retentionD1: Number(payload.d1_retention ?? 23.0),
        retentionD7: Number(payload.d7_retention ?? 4.0),
        avgSessionMinutes: Number(payload.avg_session_duration_minutes ?? 10.0),
        isHeuristic: false
      };
    } catch {
      return null;
    }
  }
}

function selectGenreBenchmark(subcategories = []) {
  for (const raw of subcategories || []) {
    const key = String(raw || '').trim().toLowerCase();
    if (GENRE_BENCHMARKS[key]) return GENRE_BENCHMARKS[key];
  }
  return GENRE_BENCHMARKS.default;
}

function computeEngagementAndRevenue({
  subcategories = [],
  historyRows = [],
  realInstalls = 0,
  installsDelta1d = 0,
  installsAvgDaily7d = 0,
  releaseDate = null,
  panelData = null
}) {
  const benchmark = selectGenreBenchmark(subcategories);
  const retentionD1 = panelData ? Number(panelData.retentionD1) : benchmark.d1;
  const retentionD7 = panelData ? Number(panelData.retentionD7) : benchmark.d7;
  const avgSessionMinutes = panelData ? Number(panelData.avgSessionMinutes) : benchmark.session;
  const isHeuristic = !panelData;

  const d1Frac = Math.max(0.01, Math.min(0.95, retentionD1 / 100));
  const d7Frac = Math.max(0.002, Math.min(d1Frac, retentionD7 / 100));
  const b = Math.log(d1Frac / d7Frac) / Math.log(7);
  const retentionAtDay = (d) => {
    if (d <= 0) return 1.0;
    if (d === 1) return d1Frac;
    return d1Frac * Math.pow(d, -b);
  };

  let estimatedDau = 0;
  if (panelData && Number.isFinite(panelData.estimatedDau)) {
    estimatedDau = Math.round(panelData.estimatedDau);
  } else {
    const sorted = [...(historyRows || [])]
      .map(r => ({
        date: parseDateSafe(r.snapshot_date || r.date),
        dailyDelta: Math.max(0, Number(r.daily_delta ?? r.dailyDelta ?? 0))
      }))
      .filter(r => r.date)
      .sort((a, b) => b.date.localeCompare(a.date));

    const steadyDailyCohort = sorted.length >= 14
      ? sorted.slice(0, 30).reduce((s, r) => s + r.dailyDelta, 0) / Math.min(30, sorted.length)
      : Math.max(
          1,
          installsAvgDaily7d > 0
            ? Math.round(realInstalls / 90)
            : Math.round(realInstalls / 120)
        );

    let cohortSum = 0;
    for (let d = 0; d <= 30; d++) {
      const hasExactDay = d < sorted.length && sorted.length >= 14;
      const installsAtDay = hasExactDay ? sorted[d].dailyDelta : steadyDailyCohort;
      cohortSum += installsAtDay * retentionAtDay(d);
    }
    estimatedDau = Math.max(10, Math.round(cohortSum / 100) * 100);
  }

  let releasedWithin30Days = false;
  const parsedRelease = parseDateSafe(releaseDate);
  if (parsedRelease) {
    const ageDays = (Date.now() - new Date(parsedRelease + 'T00:00:00Z').getTime()) / 86400000;
    if (ageDays >= 0 && ageDays < 30) releasedWithin30Days = true;
  }

  let revConfidence = 'high';
  if (isHeuristic || Number(installsDelta1d) > Number(estimatedDau) || releasedWithin30Days) {
    revConfidence = 'low';
  } else if (realInstalls < 50000) {
    revConfidence = 'medium';
  }

  const sessionScale = avgSessionMinutes / 10;
  const revMonthlyMin = Math.round(estimatedDau * 30 * sessionScale * 0.00042);
  const revMonthlyMax = Math.round(estimatedDau * 30 * sessionScale * 0.00377);

  return {
    estimatedDau,
    retentionD1,
    retentionD7,
    avgSessionMinutes,
    revMonthlyMin,
    revMonthlyMax,
    revConfidence
  };
}

async function runEngagementRevenuePipeline(pool, packageName, context = {}) {
  const provider = new EngagementDataProvider();
  const panelData = await provider.getEngagementMetrics(packageName);

  const { rows: gameRows } = await pool.query(
    `SELECT real_installs, installs_delta_1d, installs_avg_daily_7d, subcategories, release_date, released
     FROM games WHERE package_name = $1 LIMIT 1`,
    [packageName]
  );
  const game = gameRows[0] || {};

  const { rows: historyRows } = await pool.query(
    `SELECT snapshot_date::text AS snapshot_date, real_installs, daily_delta
     FROM app_install_history
     WHERE package_name = $1
     ORDER BY snapshot_date DESC
     LIMIT 31`,
    [packageName]
  );

  const subcategories = Array.isArray(context.subcategories) && context.subcategories.length
    ? context.subcategories
    : (Array.isArray(game.subcategories) ? game.subcategories : []);

  const realInstalls = Number(context.realInstalls ?? game.real_installs ?? 0);
  const installsDelta1d = Number(context.installsDelta1d ?? game.installs_delta_1d ?? 0);
  const installsAvgDaily7d = Number(context.installsAvgDaily7d ?? game.installs_avg_daily_7d ?? 0);
  const releaseDate = context.releaseDate || game.release_date || game.released || null;

  const metrics = computeEngagementAndRevenue({
    subcategories,
    historyRows,
    realInstalls,
    installsDelta1d,
    installsAvgDaily7d,
    releaseDate,
    panelData
  });

  await pool.query(
    `UPDATE games
     SET estimated_dau = $2,
         retention_d1 = $3,
         retention_d7 = $4,
         avg_session_minutes = $5,
         rev_monthly_min = $6,
         rev_monthly_max = $7,
         rev_confidence = $8
     WHERE package_name = $1`,
    [
      packageName,
      metrics.estimatedDau,
      metrics.retentionD1,
      metrics.retentionD7,
      metrics.avgSessionMinutes,
      metrics.revMonthlyMin,
      metrics.revMonthlyMax,
      metrics.revConfidence
    ]
  );

  return metrics;
}

// ============================================================================
// Orchestrator: Run All 4 Telemetry Pipelines & Ensure Game Record Exists
// ============================================================================
async function ensureGameRowForTelemetry(pool, packageName, ds5) {
  const { rows } = await pool.query(`SELECT id FROM games WHERE package_name = $1 LIMIT 1`, [packageName]);
  if (rows.length > 0) return rows[0].id;

  const title = ds5?.title || packageName;
  const genre = ds5?.subcategories?.[0] || 'Simulation';
  const installs = ds5?.installsTier || '0+';
  const minInstalls = Number(String(installs).replace(/[^0-9]/g, '')) || 0;
  const released = ds5?.rawReleaseDate || ds5?.releaseDate || 'Unknown';

  const insertRes = await pool.query(
    `INSERT INTO games (
       package_name, title, category, rating, ratings_count, icon,
       screenshots, description, installs, min_installs, released,
       updated, similar_apps, ad_count, header_image
     )
     VALUES ($1, $2, $3, $4, $5, $6, '[]', $7, $8, $9, $10, 0, '[]', 0, $11)
     ON CONFLICT (package_name) DO UPDATE SET title = COALESCE(EXCLUDED.title, games.title)
     RETURNING id`,
    [
      packageName,
      title,
      genre,
      ds5?.rating || 0,
      ds5?.ratingsCount || 0,
      ds5?.icon || null,
      ds5?.longDescription || ds5?.shortDescription || '',
      installs,
      minInstalls,
      released,
      ds5?.headerImage || null
    ]
  );

  return insertRes.rows[0]?.id || null;
}

async function runFullTelemetryForPackage(pool, packageName, options = {}) {
  const pkg = String(packageName || '').trim();
  if (!pkg) throw new Error('package_name is required');

  let ds5 = null;
  try {
    ds5 = await fetchPlayStoreDs5(pkg);
  } catch (err) {
    console.warn(`[PlayTelemetry] Play Store ds:5 fetch warning for ${pkg}: ${err.message}`);
  }

  await ensureGameRowForTelemetry(pool, pkg, ds5);

  let p1 = null;
  if (ds5) {
    p1 = await runInstallVelocityPipeline(pool, pkg, ds5);
  }

  const [p2, p3] = await Promise.all([
    options.skipNetworks
      ? Promise.resolve(null)
      : runNetworkAdvertiserPipeline(pool, pkg, {
          developerWebsite: ds5?.developerWebsite || null,
          developerName: ds5?.developerName || null,
          forceRefresh: Boolean(options.forceRefresh),
          allowRemoteSellersFetch: Boolean(options.allowRemoteSellersFetch),
          skipSuggestionsRpc: Boolean(options.skipSuggestionsRpc)
        }),
    options.skipCard
      ? Promise.resolve(null)
      : runCardStatusPipeline(pool, pkg)
  ]);

  const p4 = await runEngagementRevenuePipeline(pool, pkg, {
    subcategories: ds5?.subcategories,
    realInstalls: p1?.velocity?.realInstalls,
    installsDelta1d: p1?.velocity?.installsDelta1d,
    installsAvgDaily7d: p1?.velocity?.installsAvgDaily7d,
    releaseDate: p1?.releaseDate
  });

  const { rows } = await pool.query(
    `SELECT g.*,
            (SELECT MAX(ac.last_seen_at)
             FROM ad_creatives ac
             WHERE ac.package_name = g.package_name OR ac.game_id = g.id) AS latest_creative_seen,
            COALESCE(
              (SELECT json_agg(
                 json_build_object(
                   'date', h.snapshot_date::text,
                   'realInstalls', h.real_installs,
                   'dailyDelta', h.daily_delta
                 ) ORDER BY h.snapshot_date ASC
               )
               FROM (
                 SELECT snapshot_date, real_installs, daily_delta
                 FROM app_install_history
                 WHERE package_name = g.package_name
                 ORDER BY snapshot_date DESC
                 LIMIT 14
               ) h),
              '[]'::json
            ) AS install_history
     FROM games g
     WHERE g.package_name = $1
     LIMIT 1`,
    [pkg]
  );

  return {
    game: rows[0] || null,
    pipelines: {
      installs: p1,
      networks: p2,
      card: p3,
      engagement: p4
    }
  };
}

// ============================================================================
// Background Workers & Priority Queues
// ============================================================================
function startTelemetryBackgroundWorkers(pool) {
  const cardQueue = createBoundedQueue(
    async (task) => {
      await runCardStatusPipeline(pool, task.packageName);
    },
    { concurrency: 1, maxPending: 100 }
  );

  const telemetryQueue = createBoundedQueue(
    async (task) => {
      await runFullTelemetryForPackage(pool, task.packageName, task.options || {});
    },
    { concurrency: 2, maxPending: 200 }
  );

  const sweepIntervalMs = 6 * 60 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      const { rows: dueInstalls } = await pool.query(
        `SELECT package_name
         FROM games
         WHERE COALESCE(is_suspended, false) = false
           AND (installs_scanned_at IS NULL OR installs_scanned_at < now() - INTERVAL '24 hours')
         ORDER BY COALESCE(installs_delta_1d, 0) DESC, ad_count DESC
         LIMIT 6`
      );
      for (const row of dueInstalls) {
        void telemetryQueue.enqueue({ packageName: row.package_name });
      }

      const { rows: dueCards } = await pool.query(
        `SELECT package_name
         FROM games
         WHERE COALESCE(is_suspended, false) = false
           AND (card_scanned_at IS NULL OR card_scanned_at < now() - INTERVAL '24 hours')
         ORDER BY (CASE WHEN COALESCE(installs_delta_1d, 0) > 1000 THEN 0 ELSE 1 END),
                  COALESCE(installs_delta_1d, 0) DESC,
                  id DESC
         LIMIT 10`
      );
      for (const row of dueCards) {
        void cardQueue.enqueue({ packageName: row.package_name });
      }
    } catch (err) {
      console.warn('[PlayTelemetry] Background worker sweep error:', err.message);
    }
  }, sweepIntervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return { cardQueue, telemetryQueue };
}

function registerPlayTelemetryRoutes({ app, pool }) {
  const workers = startTelemetryBackgroundWorkers(pool);

  app.get('/api/telemetry/:packageName', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const pkg = String(req.params.packageName || '').trim();
      if (!pkg) return res.status(400).json({ error: 'packageName is required' });

      // Always refresh live ad-signal card status quickly from ad_creatives
      await runCardStatusPipeline(pool, pkg).catch(() => {});

      const { rows } = await pool.query(
        `SELECT g.*,
                (SELECT MAX(ac.last_seen_at)
                 FROM ad_creatives ac
                 WHERE ac.package_name = g.package_name OR ac.game_id = g.id) AS latest_creative_seen,
                COALESCE(
                  (SELECT json_agg(
                     json_build_object(
                       'date', h.snapshot_date::text,
                       'realInstalls', h.real_installs,
                       'dailyDelta', h.daily_delta
                     ) ORDER BY h.snapshot_date ASC
                   )
                   FROM (
                     SELECT snapshot_date, real_installs, daily_delta
                     FROM app_install_history
                     WHERE package_name = g.package_name
                     ORDER BY snapshot_date DESC
                     LIMIT 14
                   ) h),
                  '[]'::json
                ) AS install_history
         FROM games g
         WHERE g.package_name = $1
         LIMIT 1`,
        [pkg]
      );

      if (
        rows.length > 0 &&
        rows[0].real_installs != null &&
        rows[0].store_scanned_at &&
        rows[0].network_data &&
        typeof rows[0].network_data === 'object' &&
        rows[0].network_data.scannedAt
      ) {
        return res.json(rows[0]);
      }

      const result = await runFullTelemetryForPackage(pool, pkg, { forceRefresh: true });
      return res.json(result.game);
    } catch (error) {
      console.error('[PlayTelemetry] GET /api/telemetry error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to load package telemetry' });
    }
  });

  app.post('/api/telemetry/:packageName/scan', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const pkg = String(req.params.packageName || '').trim();
      if (!pkg) return res.status(400).json({ error: 'packageName is required' });

      const result = await runFullTelemetryForPackage(pool, pkg, {
        ...(req.body || {}),
        forceRefresh: true
      });
      return res.json(result);
    } catch (error) {
      console.error('[PlayTelemetry] POST /api/telemetry/scan error:', error.message);
      res.status(500).json({ error: error.message || 'Telemetry scan failed' });
    }
  });

  return workers;
}

module.exports = {
  KNOWN_AD_NETWORKS,
  GENRE_BENCHMARKS,
  initializePlayTelemetryStorage,
  parsePlayStoreDs5Html,
  fetchPlayStoreDs5,
  computeVelocityMetrics,
  runInstallVelocityPipeline,
  computeProportionalShareMap,
  parseAppAdsTxtContent,
  fetchAndParseAppAdsTxt,
  inferNetworksFromCreativeLinks,
  lookupGoogleSellersJson,
  selectPrimaryStudioSeller,
  queryAdsTransparencySuggestions,
  resolveAdvertiserLegalName,
  runNetworkAdvertiserPipeline,
  evaluateCardStatusFromAdSignals,
  runCardStatusPipeline,
  EngagementDataProvider,
  computeEngagementAndRevenue,
  runEngagementRevenuePipeline,
  runFullTelemetryForPackage,
  registerPlayTelemetryRoutes
};
