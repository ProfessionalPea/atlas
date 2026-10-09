// Load additive Atlas intelligence routes/storage before server.js creates its
// Express app. The extension hooks app.listen so the routes inherit Atlas's
// existing /api authentication middleware without changing server.js.
const { extensionPool } = require('./AtlasExtensions');
const scanner = require('./GoogleAdsScannerV6');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;
const { recordDiscoveredPackages } = require('./ScanDiscoveryRegistry');

const PENDING_PUBLISHER = 'Pending metadata';

async function initializeCreativeOwnershipAccounting() {
  try {
    await extensionPool.query(`
      CREATE OR REPLACE FUNCTION atlas_refresh_game_ad_count()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP <> 'INSERT' AND OLD.game_id IS NOT NULL THEN
          UPDATE games
          SET ad_count = (
            SELECT COUNT(DISTINCT ac.creative_id)::int
            FROM ad_creatives ac
            WHERE ac.game_id = OLD.game_id
          )
          WHERE id = OLD.game_id;
        END IF;

        IF TG_OP <> 'DELETE' AND NEW.game_id IS NOT NULL THEN
          UPDATE games
          SET ad_count = (
            SELECT COUNT(DISTINCT ac.creative_id)::int
            FROM ad_creatives ac
            WHERE ac.game_id = NEW.game_id
          )
          WHERE id = NEW.game_id;
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_atlas_refresh_game_ad_count ON ad_creatives;
      CREATE TRIGGER trg_atlas_refresh_game_ad_count
      AFTER INSERT OR UPDATE OF game_id, package_name OR DELETE ON ad_creatives
      FOR EACH ROW EXECUTE FUNCTION atlas_refresh_game_ad_count();

      UPDATE games g
      SET ad_count = (
        SELECT COUNT(DISTINCT ac.creative_id)::int
        FROM ad_creatives ac
        WHERE ac.game_id = g.id
      );
    `);
    return true;
  } catch (error) {
    console.warn('📊 [Ads] Creative ownership accounting init skipped:', error.message);
    return false;
  }
}

void initializeCreativeOwnershipAccounting().then(ok => {
  if (!ok) setTimeout(() => { void initializeCreativeOwnershipAccounting(); }, 5000);
});

async function clearUnresolvedCreativeCache() {
  try {
    const result = await extensionPool.query(`
      DELETE FROM creative_extraction_cache
      WHERE COALESCE(package_names, '[]'::jsonb) = '[]'::jsonb
         OR COALESCE(extraction_version, 0) < 6
    `);

    if (result.rowCount > 0) {
      console.log(`🧭 [Resolver] Retrying ${result.rowCount} stale/unresolved creative${result.rowCount === 1 ? '' : 's'} with scanner v6.`);
    }
  } catch (error) {
    console.warn('🧭 [Resolver] Creative-cache cleanup skipped:', error.message);
  }
}

function fixUrl(url) {
  return url && String(url).startsWith('//') ? `https:${url}` : (url || null);
}

function normalizePublisherName(value) {
  const name = String(value || '').trim() || 'Unknown Publisher';
  return {
    name,
    normalized: name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknownpublisher'
  };
}

function normalizePackageName(value) {
  return String(value || '').trim().toLowerCase();
}

function collectPackageEvidence(rawResults) {
  const evidence = new Map();
  const ensure = packageName => {
    const pkg = normalizePackageName(packageName);
    if (!pkg) return null;
    if (!evidence.has(pkg)) {
      evidence.set(pkg, {
        packageName: pkg,
        occurrences: 0,
        canonicalEvidence: false,
        storeEvidence: false,
        metadataEvidence: false
      });
    }
    return evidence.get(pkg);
  };

  for (const entry of rawResults || []) {
    const discovered = new Set([
      ...(Array.isArray(entry?.discoveredPackages) ? entry.discoveredPackages : []),
      entry?.package
    ].map(normalizePackageName).filter(Boolean));
    const store = new Set((entry?.storeCandidatePackages || []).map(normalizePackageName).filter(Boolean));
    const metadata = new Set((entry?.metadataCandidatePackages || []).map(normalizePackageName).filter(Boolean));
    const canonical = normalizePackageName(entry?.package);

    for (const pkg of discovered) {
      const item = ensure(pkg);
      if (!item) continue;
      item.occurrences += 1;
      if (store.has(pkg)) item.storeEvidence = true;
      if (metadata.has(pkg)) item.metadataEvidence = true;
      if (canonical === pkg) item.canonicalEvidence = true;
    }
  }

  return evidence;
}

async function getCompetitorForScan(searchQuery) {
  const query = String(searchQuery || '').trim();
  if (!query) return null;

  try {
    if (/^AR[0-9]{15,}$/i.test(query)) {
      return (await extensionPool.query(
        `SELECT id, name, ads_id
         FROM competitors
         WHERE ads_id = $1
         ORDER BY CASE WHEN name <> ads_id THEN 0 ELSE 1 END, id DESC
         LIMIT 1`,
        [query.toUpperCase()]
      )).rows[0] || null;
    }

    return (await extensionPool.query(
      `SELECT id, name, ads_id
       FROM competitors
       WHERE LOWER(name) = LOWER($1)
       ORDER BY id DESC
       LIMIT 1`,
      [query]
    )).rows[0] || null;
  } catch (error) {
    console.warn('🧭 [Discovery] Could not resolve competitor for discovered packages:', error.message);
    return null;
  }
}

async function fetchPlayMetadata(packageName, targetCountry) {
  const countries = [];
  const requested = String(targetCountry || '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(requested)) countries.push(requested);
  if (!countries.includes('us')) countries.push('us');
  countries.push(null);

  for (const country of countries) {
    try {
      return await gplay.app(country
        ? { appId: packageName, country }
        : { appId: packageName });
    } catch {}
  }
  return null;
}

async function getExistingGames(packageNames) {
  if (!packageNames.length) return new Map();
  try {
    const { rows } = await extensionPool.query(
      `SELECT
         g.*,
         (
           SELECT a.publisher_name
           FROM account_games ag
           JOIN accounts a ON a.id = ag.account_id
           WHERE ag.game_id = g.id
           ORDER BY CASE WHEN a.normalized_name = 'pendingmetadata' THEN 1 ELSE 0 END, a.id ASC
           LIMIT 1
         ) AS existing_publisher_name
       FROM games g
       WHERE LOWER(g.package_name) = ANY($1::text[])`,
      [packageNames.map(pkg => pkg.toLowerCase())]
    );
    return new Map(rows.map(row => [String(row.package_name).toLowerCase(), row]));
  } catch (error) {
    console.warn('🧭 [Discovery] Existing-game lookup failed:', error.message);
    return new Map();
  }
}

function existingNeedsMetadataRefresh(existing, packageName) {
  if (!existing) return true;
  return (
    !existing.icon ||
    normalizePackageName(existing.title) === packageName ||
    String(existing.existing_publisher_name || '').toLowerCase() === PENDING_PUBLISHER.toLowerCase()
  );
}

async function validateDiscoveredPackages(rawResults, targetCountry) {
  const evidence = collectPackageEvidence(rawResults);
  const packages = [...evidence.keys()];
  const existingGames = await getExistingGames(packages);
  const validated = new Map();
  let consecutiveLookupFailures = 0;
  let playLookupCircuitOpen = false;

  const stats = {
    candidates: packages.length,
    existing: 0,
    playValidated: 0,
    acceptedFromStoreEvidence: 0,
    rejectedMetadataOnly: 0,
    lookupCircuitOpened: false
  };

  for (const packageName of packages) {
    const packageEvidence = evidence.get(packageName);
    const existing = existingGames.get(packageName) || null;
    let appData = null;

    if (existing) stats.existing += 1;

    const shouldLookup = existingNeedsMetadataRefresh(existing, packageName) && !playLookupCircuitOpen;
    if (shouldLookup) {
      appData = await fetchPlayMetadata(packageName, targetCountry);
      if (appData) {
        consecutiveLookupFailures = 0;
        stats.playValidated += 1;
      } else {
        consecutiveLookupFailures += 1;
        if (consecutiveLookupFailures >= 4) {
          playLookupCircuitOpen = true;
          stats.lookupCircuitOpened = true;
          console.warn('🧭 [Discovery] Google Play metadata lookup is failing repeatedly; keeping explicit Play-destination packages and skipping unsafe metadata-only guesses for the rest of this scan.');
        }
      }
    }

    if (existing) {
      validated.set(packageName, {
        packageName,
        existing,
        appData,
        evidence: packageEvidence,
        acceptedBy: appData ? 'play' : 'existing'
      });
      continue;
    }

    if (appData) {
      validated.set(packageName, {
        packageName,
        existing: null,
        appData,
        evidence: packageEvidence,
        acceptedBy: 'play'
      });
      continue;
    }

    if (packageEvidence?.storeEvidence) {
      stats.acceptedFromStoreEvidence += 1;
      validated.set(packageName, {
        packageName,
        existing: null,
        appData: null,
        evidence: packageEvidence,
        acceptedBy: 'store-evidence'
      });
      continue;
    }

    stats.rejectedMetadataOnly += 1;
    console.log(`🧹 [Discovery] Rejected metadata-only package that Google Play could not validate: ${packageName}`);
  }

  validated.discoveryStats = stats;
  return validated;
}

function appDataFromExisting(existing, fallbackPublisher) {
  if (!existing) return null;
  return {
    title: existing.title || existing.package_name,
    developer: existing.existing_publisher_name || fallbackPublisher || 'Unknown Publisher',
    developerId: existing.developer_id || null,
    genre: existing.category || 'Game',
    score: Number(existing.rating) || 0,
    ratings: Number(existing.ratings_count) || 0,
    icon: existing.icon || null,
    screenshots: Array.isArray(existing.screenshots) ? existing.screenshots : [],
    description: existing.description || '',
    installs: existing.installs || '0+',
    minInstalls: Number(existing.min_installs) || 0,
    released: existing.released || 'Unknown',
    updated: existing.updated || 0,
    headerImage: existing.header_image || null,
    video: existing.video || null,
    videoImage: existing.video_image || null,
    free: existing.is_paid !== true,
    price: existing.price == null ? 0 : Number(existing.price),
    currency: existing.currency || null,
    priceText: existing.price_text || null
  };
}

function appDataFromStoreEvidence(packageName) {
  return {
    title: packageName,
    developer: PENDING_PUBLISHER,
    developerId: null,
    genre: 'Game',
    score: 0,
    ratings: 0,
    icon: null,
    screenshots: [],
    description: 'Discovered from an explicit Google Play destination. Storefront metadata is pending refresh.',
    installs: '0+',
    minInstalls: 0,
    released: 'Unknown',
    updated: 0,
    headerImage: null,
    video: null,
    videoImage: null,
    free: true,
    price: 0,
    currency: null,
    priceText: null
  };
}

async function persistValidatedDiscovery(validation, competitor) {
  const packageName = validation.packageName;
  const existing = validation.existing;
  const appData = validation.appData ||
    appDataFromExisting(existing, competitor?.name) ||
    (validation.acceptedBy === 'store-evidence' ? appDataFromStoreEvidence(packageName) : null);
  if (!appData) return null;

  const publisher = normalizePublisherName(appData.developer || existing?.existing_publisher_name || PENDING_PUBLISHER);
  const developerId = appData.developerId ? String(appData.developerId) : (existing?.developer_id || null);
  const developerUrl = developerId
    ? `https://play.google.com/store/apps/dev?id=${encodeURIComponent(developerId)}`
    : (existing?.developer_url || `https://play.google.com/store/search?q=${encodeURIComponent(publisher.name)}&c=apps`);

  const screenshots = Array.isArray(appData.screenshots)
    ? appData.screenshots.map(fixUrl).filter(Boolean)
    : (Array.isArray(existing?.screenshots) ? existing.screenshots : []);
  const isPaid = appData.free === false && Number(appData.price) > 0;

  const { rows } = await extensionPool.query(
    `INSERT INTO games (
       package_name, title, category, rating, ratings_count, icon,
       screenshots, description, installs, min_installs, released,
       updated, similar_apps, ad_count, header_image, video, video_image,
       developer_id, developer_url, is_paid, price, currency, price_text
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,0,
       $14,$15,$16,$17,$18,$19,$20,$21,$22
     )
     ON CONFLICT (package_name) DO UPDATE SET
       title = CASE
         WHEN EXCLUDED.title = EXCLUDED.package_name AND games.title IS NOT NULL AND games.title <> games.package_name
           THEN games.title
         ELSE COALESCE(NULLIF(EXCLUDED.title, ''), games.title)
       END,
       category = COALESCE(NULLIF(EXCLUDED.category, ''), games.category),
       rating = CASE WHEN EXCLUDED.rating > 0 THEN EXCLUDED.rating ELSE games.rating END,
       ratings_count = CASE WHEN EXCLUDED.ratings_count > 0 THEN EXCLUDED.ratings_count ELSE games.ratings_count END,
       icon = COALESCE(EXCLUDED.icon, games.icon),
       screenshots = CASE
         WHEN jsonb_array_length(EXCLUDED.screenshots) > 0 THEN EXCLUDED.screenshots
         ELSE games.screenshots
       END,
       description = CASE
         WHEN EXCLUDED.description LIKE 'Discovered from an explicit Google Play destination.%' AND NULLIF(games.description, '') IS NOT NULL
           THEN games.description
         ELSE COALESCE(NULLIF(EXCLUDED.description, ''), games.description)
       END,
       installs = CASE WHEN EXCLUDED.installs <> '0+' THEN EXCLUDED.installs ELSE COALESCE(games.installs, EXCLUDED.installs) END,
       min_installs = GREATEST(COALESCE(games.min_installs, 0), COALESCE(EXCLUDED.min_installs, 0)),
       released = CASE WHEN EXCLUDED.released <> 'Unknown' THEN EXCLUDED.released ELSE COALESCE(games.released, EXCLUDED.released) END,
       updated = GREATEST(COALESCE(games.updated, 0), COALESCE(EXCLUDED.updated, 0)),
       header_image = COALESCE(EXCLUDED.header_image, games.header_image),
       video = COALESCE(EXCLUDED.video, games.video),
       video_image = COALESCE(EXCLUDED.video_image, games.video_image),
       developer_id = COALESCE(EXCLUDED.developer_id, games.developer_id),
       developer_url = COALESCE(EXCLUDED.developer_url, games.developer_url),
       is_paid = CASE WHEN EXCLUDED.is_paid THEN TRUE ELSE games.is_paid END,
       price = COALESCE(EXCLUDED.price, games.price),
       currency = COALESCE(EXCLUDED.currency, games.currency),
       price_text = COALESCE(EXCLUDED.price_text, games.price_text)
     RETURNING id`,
    [
      packageName,
      appData.title || existing?.title || packageName,
      appData.genre || existing?.category || 'Game',
      Number(appData.score) || 0,
      Number(appData.ratings) || 0,
      fixUrl(appData.icon) || existing?.icon || null,
      JSON.stringify(screenshots),
      appData.description || existing?.description || '',
      appData.installs || existing?.installs || '0+',
      Number(appData.minInstalls) || Number(existing?.min_installs) || 0,
      appData.released || existing?.released || 'Unknown',
      Number(appData.updated) || Number(existing?.updated) || 0,
      JSON.stringify(Array.isArray(existing?.similar_apps) ? existing.similar_apps : []),
      fixUrl(appData.headerImage) || existing?.header_image || null,
      appData.video || existing?.video || null,
      fixUrl(appData.videoImage) || existing?.video_image || null,
      developerId,
      developerUrl,
      isPaid,
      isPaid ? Number(appData.price) : null,
      isPaid ? (appData.currency || null) : null,
      isPaid ? (appData.priceText || null) : null
    ]
  );

  const gameId = rows[0]?.id;
  if (!gameId || !competitor?.id) return gameId || null;

  if (validation.appData?.developer && publisher.normalized !== 'pendingmetadata') {
    await extensionPool.query(
      `DELETE FROM account_games ag
       USING accounts a
       WHERE ag.account_id = a.id
         AND ag.game_id = $1
         AND a.competitor_id = $2
         AND a.normalized_name = 'pendingmetadata'`,
      [gameId, competitor.id]
    ).catch(() => {});
    await extensionPool.query(
      `DELETE FROM accounts a
       WHERE a.competitor_id = $1
         AND a.normalized_name = 'pendingmetadata'
         AND NOT EXISTS (SELECT 1 FROM account_games ag WHERE ag.account_id = a.id)`,
      [competitor.id]
    ).catch(() => {});
  }

  let account = (await extensionPool.query(
    `SELECT id
     FROM accounts
     WHERE competitor_id = $1 AND normalized_name = $2
     ORDER BY id ASC
     LIMIT 1`,
    [competitor.id, publisher.normalized]
  )).rows[0];

  if (!account) {
    account = (await extensionPool.query(
      `INSERT INTO accounts (competitor_id, publisher_name, normalized_name)
       VALUES ($1,$2,$3)
       RETURNING id`,
      [competitor.id, publisher.name, publisher.normalized]
    )).rows[0];
  }

  if (account?.id) {
    await extensionPool.query(
      `INSERT INTO account_games (account_id, game_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [account.id, gameId]
    );
  }

  return gameId;
}

async function reconcileVideoLinks() {
  try {
    await extensionPool.query(`
      UPDATE ad_video_links avl
      SET game_id = g.id
      FROM games g
      WHERE avl.game_id IS NULL
        AND NULLIF(avl.package_name, '') IS NOT NULL
        AND avl.package_name = g.package_name;

      UPDATE ad_video_links avl
      SET competitor_id = a.competitor_id
      FROM games g
      JOIN account_games ag ON ag.game_id = g.id
      JOIN accounts a ON a.id = ag.account_id
      WHERE avl.competitor_id IS NULL
        AND NULLIF(avl.package_name, '') IS NOT NULL
        AND avl.package_name = g.package_name
        AND a.competitor_id IS NOT NULL;

      DELETE FROM ad_video_links transient_link
      USING video_assets transient_asset
      WHERE transient_link.asset_id = transient_asset.id
        AND transient_asset.source = 'youtube'
        AND transient_asset.youtube_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM ad_video_links stable_link
          JOIN video_assets stable_asset ON stable_asset.id = stable_link.asset_id
          WHERE stable_link.creative_id = transient_link.creative_id
            AND stable_link.package_name = transient_link.package_name
            AND stable_asset.youtube_id IS NOT NULL
        );

      DELETE FROM video_assets va
      WHERE va.source = 'youtube'
        AND va.youtube_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ad_video_links avl WHERE avl.asset_id = va.id
        );
    `);
  } catch (error) {
    console.warn('🎬 [Video] Post-scan reconciliation skipped:', error.message);
  }
}

async function scanCompetitor(...args) {
  await clearUnresolvedCreativeCache();

  const rawResults = await scanner.scanCompetitor(...args);
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    setTimeout(() => { void reconcileVideoLinks(); }, 5000);
    return [];
  }

  let validated = new Map();
  try {
    validated = await validateDiscoveredPackages(rawResults, args[1]);
  } catch (error) {
    console.warn('🧭 [Discovery] Package validation failed:', error.message);
  }

  const competitor = await getCompetitorForScan(args[0]);
  const onPackageFound = typeof args[4] === 'function' ? args[4] : async () => {};
  const persistedPackages = new Set();

  for (const validation of validated.values()) {
    try {
      const gameId = await persistValidatedDiscovery(validation, competitor);
      if (gameId) {
        persistedPackages.add(validation.packageName);
        await onPackageFound(validation.packageName);
      }
    } catch (error) {
      console.warn(`🧭 [Discovery] Failed to persist ${validation.packageName}:`, error.message);
    }
  }

  const canonicalResults = rawResults
    .map(entry => {
      const discoveredPackages = [...new Set(
        (entry.discoveredPackages || [])
          .map(pkg => normalizePackageName(pkg))
          .filter(pkg => persistedPackages.has(pkg))
      )];
      const packageName = entry.package ? normalizePackageName(entry.package) : null;
      if (!packageName || !persistedPackages.has(packageName)) return null;
      return {
        ...entry,
        package: packageName,
        discoveredPackages,
        candidatePackages: discoveredPackages
      };
    })
    .filter(Boolean);

  canonicalResults.discoveredPackages = [...persistedPackages];
  canonicalResults.discoveryOnlyPackages = [...persistedPackages].filter(pkg =>
    !canonicalResults.some(entry => entry.package === pkg)
  );
  canonicalResults.discoveryStats = validated.discoveryStats || {};
  recordDiscoveredPackages(canonicalResults.discoveredPackages, canonicalResults.discoveryStats);

  const stats = canonicalResults.discoveryStats;
  const canonicalPackageCount = new Set(canonicalResults.map(entry => entry.package)).size;
  console.log(
    `🧭 [Discovery] Persisted ${persistedPackages.size}/${stats.candidates || 0} package candidate${stats.candidates === 1 ? '' : 's'}; ` +
    `${canonicalPackageCount} have canonical creative ownership. ` +
    `${stats.acceptedFromStoreEvidence || 0} accepted from explicit Play destinations while metadata was unavailable; ` +
    `${stats.rejectedMetadataOnly || 0} unsafe metadata-only candidate${stats.rejectedMetadataOnly === 1 ? '' : 's'} rejected.`
  );

  setTimeout(() => { void reconcileVideoLinks(); }, 5000);
  setTimeout(() => { void reconcileVideoLinks(); }, 30000);
  return canonicalResults;
}

module.exports = {
  ...scanner,
  scanCompetitor,
  collectPackageEvidence,
  validateDiscoveredPackages,
  persistValidatedDiscovery,
  existingNeedsMetadataRefresh
};
