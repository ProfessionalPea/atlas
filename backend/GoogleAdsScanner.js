// Load additive Atlas intelligence routes/storage before server.js creates its
// Express app. The extension hooks app.listen so the routes inherit Atlas's
// existing /api authentication middleware without changing server.js.
const { extensionPool } = require('./AtlasExtensions');
const scanner = require('./GoogleAdsScannerV5');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

async function initializeCreativeOwnershipAccounting() {
  try {
    // games.ad_count used to be increment-only, so one creative accidentally
    // attributed to several packages permanently inflated every affected game.
    // Keep the display counter derived from the actual creative ownership table
    // instead. Moving/deleting a creative automatically repairs both old/new
    // owners as v5 re-resolves historical creatives.
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

// server.js creates ad_creatives in its own startup initializer. Existing Atlas
// databases have it already, while a fresh install can race this module import;
// retry once after startup so the trigger is present in both cases.
void initializeCreativeOwnershipAccounting().then(ok => {
  if (!ok) setTimeout(() => { void initializeCreativeOwnershipAccounting(); }, 5000);
});

async function clearUnresolvedCreativeCache() {
  try {
    // v5 deliberately writes [] for unresolved and multi-package creatives so
    // they are never frozen into a single package by cache. Successful,
    // unambiguous one-package resolutions stay cached and fast.
    const result = await extensionPool.query(`
      DELETE FROM creative_extraction_cache
      WHERE COALESCE(package_names, '[]'::jsonb) = '[]'::jsonb
    `);

    if (result.rowCount > 0) {
      console.log(`🧭 [Resolver] Retrying ${result.rowCount} unresolved/multi-package creative${result.rowCount === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    // Fresh installations can reach this wrapper before the additive
    // intelligence tables have been initialized. The scanner will create them
    // normally, so this cleanup is deliberately best-effort.
    console.warn('🧭 [Resolver] Unresolved cache cleanup skipped:', error.message);
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

async function fetchPlayMetadata(packageName) {
  try {
    return await gplay.app({ appId: packageName, country: 'us' });
  } catch {
    try {
      return await gplay.app({ appId: packageName });
    } catch {
      return null;
    }
  }
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
           ORDER BY a.id ASC
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

async function validateDiscoveredPackages(rawResults) {
  const packages = [...new Set(
    (rawResults || []).flatMap(entry => [
      ...(Array.isArray(entry?.discoveredPackages) ? entry.discoveredPackages : []),
      entry?.package
    ]).map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
  )];

  const existingGames = await getExistingGames(packages);
  const validated = new Map();

  // Validate every candidate independently. Existing Atlas packages are kept
  // even if Google Play is temporarily unavailable; brand-new packages must
  // resolve successfully in Google Play before Atlas stores them.
  for (const packageName of packages) {
    const existing = existingGames.get(packageName) || null;
    const appData = await fetchPlayMetadata(packageName);

    if (!appData && !existing) {
      console.log(`🧹 [Discovery] Rejected unverified package candidate: ${packageName}`);
      continue;
    }

    validated.set(packageName, { packageName, existing, appData });
  }

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

async function persistValidatedDiscovery(validation, competitor) {
  const packageName = validation.packageName;
  const existing = validation.existing;
  const appData = validation.appData || appDataFromExisting(existing, competitor?.name);
  if (!appData) return null;

  const publisher = normalizePublisherName(appData.developer || existing?.existing_publisher_name || competitor?.name);
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
       title = COALESCE(NULLIF(EXCLUDED.title, ''), games.title),
       category = COALESCE(NULLIF(EXCLUDED.category, ''), games.category),
       rating = EXCLUDED.rating,
       ratings_count = EXCLUDED.ratings_count,
       icon = COALESCE(EXCLUDED.icon, games.icon),
       screenshots = CASE
         WHEN jsonb_array_length(EXCLUDED.screenshots) > 0 THEN EXCLUDED.screenshots
         ELSE games.screenshots
       END,
       description = COALESCE(NULLIF(EXCLUDED.description, ''), games.description),
       installs = COALESCE(NULLIF(EXCLUDED.installs, ''), games.installs),
       min_installs = EXCLUDED.min_installs,
       released = COALESCE(NULLIF(EXCLUDED.released, ''), games.released),
       updated = EXCLUDED.updated,
       header_image = COALESCE(EXCLUDED.header_image, games.header_image),
       video = COALESCE(EXCLUDED.video, games.video),
       video_image = COALESCE(EXCLUDED.video_image, games.video_image),
       developer_id = COALESCE(EXCLUDED.developer_id, games.developer_id),
       developer_url = COALESCE(EXCLUDED.developer_url, games.developer_url),
       is_paid = EXCLUDED.is_paid,
       price = EXCLUDED.price,
       currency = EXCLUDED.currency,
       price_text = EXCLUDED.price_text
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
    // Scanner-side persistence happens before server.js finishes its normal
    // game upserts. Reconnect links to the durable game/competitor records once
    // the scan is complete so the Video Library inherits all existing Atlas
    // metadata without duplicating it.
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

      -- A googlevideo request may be observed before the creative DOM exposes
      -- the stable YouTube ID. When both refer to the same creative/package,
      -- keep the permanent YouTube-backed asset and remove the transient-only
      -- duplicate link.
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
    validated = await validateDiscoveredPackages(rawResults);
  } catch (error) {
    console.warn('🧭 [Discovery] Package validation failed; keeping only scanner-resolved packages:', error.message);
  }

  const competitor = await getCompetitorForScan(args[0]);
  const onPackageFound = typeof args[4] === 'function' ? args[4] : async () => {};

  // Store every independently validated package, even when one creative exposes
  // several games. The package_name unique key plus account_games conflict
  // handling makes this idempotent: existing games are refreshed, new games are
  // created once, and repeated package evidence never creates duplicates.
  for (const validation of validated.values()) {
    try {
      await persistValidatedDiscovery(validation, competitor);
      await onPackageFound(validation.packageName);
    } catch (error) {
      console.warn(`🧭 [Discovery] Failed to persist ${validation.packageName}:`, error.message);
    }
  }

  // server.js still owns creative/ad accounting. Only return creatives whose
  // single owner was actually resolved and whose package passed validation.
  // Secondary packages are already stored above as distinct games, without
  // falsely crediting the same creative/video to every discovered game.
  const canonicalResults = rawResults
    .map(entry => {
      const discoveredPackages = [...new Set(
        (entry.discoveredPackages || [])
          .map(pkg => String(pkg || '').toLowerCase())
          .filter(pkg => validated.has(pkg))
      )];
      const packageName = entry.package ? String(entry.package).toLowerCase() : null;
      if (!packageName || !validated.has(packageName)) return null;
      return {
        ...entry,
        package: packageName,
        discoveredPackages,
        candidatePackages: discoveredPackages
      };
    })
    .filter(Boolean);

  const discoveredCount = validated.size;
  const canonicalPackageCount = new Set(canonicalResults.map(entry => entry.package)).size;
  console.log(
    `🧭 [Discovery] Validated ${discoveredCount} unique package${discoveredCount === 1 ? '' : 's'}; ` +
    `${canonicalPackageCount} package${canonicalPackageCount === 1 ? '' : 's'} have canonical creative ownership.`
  );

  // server.js processes canonical packages immediately after this resolves. The
  // relationship pass is best-effort; package-filtered Video Library queries
  // can already join by package_name in the meantime.
  setTimeout(() => { void reconcileVideoLinks(); }, 5000);
  setTimeout(() => { void reconcileVideoLinks(); }, 30000);
  return canonicalResults;
}

module.exports = {
  ...scanner,
  scanCompetitor,
  validateDiscoveredPackages,
  persistValidatedDiscovery
};
