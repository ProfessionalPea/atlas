let videoMetadataInitPromise = null;

// Short-lived in-memory caches to eliminate repetitive remote Supabase round-trips
const VIDEO_ASSETS_CACHE_TTL_MS = 15000;
const PACKAGE_OPTIONS_CACHE_TTL_MS = 30000;
const videoAssetsCache = new Map(); // key: packageName || '__ALL__' -> { expiresAt, data }
const packageOptionsCache = new Map(); // key: normalized query -> { expiresAt, data }

function invalidateVideoMetadataCaches() {
  videoAssetsCache.clear();
  packageOptionsCache.clear();
}

function initializeVideoMetadata(pool) {
  if (videoMetadataInitPromise) return videoMetadataInitPromise;

  videoMetadataInitPromise = pool.query(`
    ALTER TABLE video_assets
      ADD COLUMN IF NOT EXISTS custom_title TEXT,
      ADD COLUMN IF NOT EXISTS manual_package_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS manual_metadata_updated_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_ad_video_links_asset_id
      ON ad_video_links(asset_id);

    CREATE INDEX IF NOT EXISTS idx_ad_video_links_creative_id
      ON ad_video_links(creative_id);

    CREATE INDEX IF NOT EXISTS idx_ad_video_links_game_id
      ON ad_video_links(game_id);

    CREATE INDEX IF NOT EXISTS idx_games_lower_package_name
      ON games(LOWER(package_name));

    CREATE INDEX IF NOT EXISTS idx_video_assets_last_seen
      ON video_assets(last_seen_at DESC, id DESC);
  `).catch(error => {
    videoMetadataInitPromise = null;
    throw error;
  });

  return videoMetadataInitPromise;
}

function normalizeStringArray(value, { maxItems, maxLength, lowercase = false } = {}) {
  const input = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];

  const seen = new Set();
  const result = [];

  for (const raw of input) {
    let item = String(raw || '').trim();
    if (!item) continue;
    if (lowercase) item = item.toLowerCase();
    if (maxLength && item.length > maxLength) item = item.slice(0, maxLength);
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (maxItems && result.length >= maxItems) break;
  }

  return result;
}

function normalizeManualPackages(value) {
  const packages = normalizeStringArray(value, {
    maxItems: 20,
    maxLength: 180,
    lowercase: true
  });

  for (const packageName of packages) {
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(packageName)) {
      const error = new Error(`Invalid package name: ${packageName}`);
      error.code = 'INVALID_PACKAGE_NAME';
      throw error;
    }
  }

  return packages;
}

function normalizeTags(value) {
  return normalizeStringArray(value, {
    maxItems: 12,
    maxLength: 40,
    lowercase: false
  });
}

function normalizeCustomTitle(value) {
  const title = String(value || '').trim();
  return title ? title.slice(0, 120) : null;
}

function toGame(row, { manual = false } = {}) {
  if (!row) return null;
  return {
    id: row.id == null ? null : Number(row.id),
    title: row.title || row.package_name || row.packageName || null,
    packageName: row.package_name || row.packageName || null,
    publisherName: row.publisher_name || row.publisherName || null,
    competitorName: row.competitor_name || row.competitorName || null,
    icon: row.icon || null,
    headerImage: row.header_image || row.headerImage || null,
    rating: row.rating == null ? null : Number(row.rating),
    installs: row.installs || null,
    isPaid: row.is_paid === true || row.isPaid === true,
    priceText: row.price_text || row.priceText || null,
    manual
  };
}

function buildVideoAssetDisplayFields(item, manualGameMap = new Map()) {
  const automaticGame = Array.isArray(item.automaticGames) && item.automaticGames.length > 0
    ? item.automaticGames[0]
    : null;
  const customTitle = item.customTitle || null;
  const packages = Array.isArray(item.manualPackageNames)
    ? item.manualPackageNames.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const tags = Array.isArray(item.tags)
    ? item.tags.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  const manualGames = packages.map(pkg => manualGameMap.get(pkg) || {
    id: null,
    title: pkg,
    packageName: pkg,
    publisherName: null,
    competitorName: null,
    icon: null,
    headerImage: null,
    rating: null,
    installs: null,
    isPaid: false,
    priceText: null,
    manual: true
  });

  const displayGames = [];
  const packageKeys = new Set();
  const baseGame = automaticGame || manualGames[0] || null;

  if (baseGame) {
    displayGames.push({
      ...baseGame,
      title: customTitle || baseGame.title || baseGame.packageName,
      manualTitle: Boolean(customTitle)
    });
    if (baseGame.packageName) packageKeys.add(String(baseGame.packageName).toLowerCase());
  } else if (customTitle) {
    displayGames.push({
      id: null,
      title: customTitle,
      packageName: null,
      publisherName: null,
      competitorName: null,
      icon: null,
      headerImage: null,
      rating: null,
      installs: null,
      isPaid: false,
      priceText: null,
      manual: true,
      manualTitle: true
    });
  }

  for (const game of manualGames) {
    const key = String(game.packageName || '').toLowerCase();
    if (!key || packageKeys.has(key)) continue;
    packageKeys.add(key);
    displayGames.push(game);
  }

  if (tags.length) {
    displayGames.push({
      id: null,
      title: tags.join(' '),
      packageName: null,
      publisherName: null,
      competitorName: null,
      searchOnly: true,
      manual: true
    });
  }

  const hasManualMetadata = Boolean(customTitle || packages.length || tags.length);
  const linkedPackageCount = Number(item.linkedPackageCount) || 0;

  return {
    ...item,
    customTitle,
    manualPackageNames: packages,
    tags,
    hasManualMetadata,
    reviewState: linkedPackageCount === 1
      ? 'resolved'
      : hasManualMetadata
        ? 'manually_organized'
        : 'unassigned',
    manualGames,
    games: displayGames
  };
}

function registerVideoMetadataRoutes({ app, pool }) {
  app.get('/api/video-assets/package-options', async (req, res) => {
    try {
      await initializeVideoMetadata(pool);
      const query = String(req.query.q || '').trim();
      const cacheKey = query.toLowerCase();
      const cached = packageOptionsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.data);
      }

      const like = `%${query}%`;
      const { rows } = await pool.query(`
        SELECT package_name, title, icon
        FROM games
        WHERE $1::text = ''
           OR package_name ILIKE $2
           OR title ILIKE $2
        ORDER BY
          CASE WHEN LOWER(package_name) = LOWER($1) THEN 0 ELSE 1 END,
          ad_count DESC,
          title ASC
        LIMIT 15
      `, [query, like]);

      const payload = rows.map(row => ({
        packageName: row.package_name,
        title: row.title || row.package_name,
        icon: row.icon || null
      }));

      packageOptionsCache.set(cacheKey, {
        expiresAt: Date.now() + PACKAGE_OPTIONS_CACHE_TTL_MS,
        data: payload
      });

      return res.json(payload);
    } catch (error) {
      console.error('Video package options fetch failed:', error);
      return res.status(500).json({ error: 'Unable to load package suggestions.' });
    }
  });

  app.patch('/api/video-assets/:assetId/metadata', async (req, res) => {
    const assetId = Number(req.params.assetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid video asset id.' });
    }

    try {
      await initializeVideoMetadata(pool);
      const customTitle = normalizeCustomTitle(req.body?.customTitle);
      const packageNames = normalizeManualPackages(req.body?.packageNames);
      const tags = normalizeTags(req.body?.tags);

      const { rows } = await pool.query(`
        UPDATE video_assets
        SET custom_title = $2,
            manual_package_names = $3::jsonb,
            tags = $4::jsonb,
            manual_metadata_updated_at = now()
        WHERE id = $1
        RETURNING id, custom_title, manual_package_names, tags, manual_metadata_updated_at
      `, [assetId, customTitle, JSON.stringify(packageNames), JSON.stringify(tags)]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Video asset not found.' });
      }

      const saved = rows[0];
      const updatedPackages = Array.isArray(saved.manual_package_names) ? saved.manual_package_names : [];
      const updatedTags = Array.isArray(saved.tags) ? saved.tags : [];
      const updatedAt = saved.manual_metadata_updated_at || null;

      // Update any warm cache entries in-place so an immediate subsequent
      // GET /api/video-assets from the frontend returns in <1ms without re-running the heavy SQL CTE!
      let manualGameMap = new Map();
      if (updatedPackages.length && videoAssetsCache.size > 0) {
        const { rows: gameRows } = await pool.query(`
          SELECT
            g.id, g.package_name, g.title, g.icon, g.header_image,
            g.rating, g.installs, g.is_paid, g.price_text,
            owner.publisher_name, owner.competitor_name
          FROM games g
          LEFT JOIN LATERAL (
            SELECT a.publisher_name, c.name AS competitor_name
            FROM account_games ag
            JOIN accounts a ON a.id = ag.account_id
            LEFT JOIN competitors c ON c.id = a.competitor_id
            WHERE ag.game_id = g.id
            ORDER BY a.id ASC
            LIMIT 1
          ) owner ON TRUE
          WHERE LOWER(g.package_name) = ANY($1::text[])
        `, [updatedPackages]);

        for (const gameRow of gameRows) {
          manualGameMap.set(String(gameRow.package_name || '').toLowerCase(), toGame(gameRow, { manual: true }));
        }
      }

      for (const [cacheKey, entry] of videoAssetsCache.entries()) {
        if (!entry || !Array.isArray(entry.data)) continue;
        if (cacheKey !== '__ALL__') {
          videoAssetsCache.delete(cacheKey);
          continue;
        }
        entry.data = entry.data.map(item => {
          if (Number(item.id) !== assetId) return item;
          return buildVideoAssetDisplayFields({
            ...item,
            customTitle: saved.custom_title || null,
            manualPackageNames: updatedPackages,
            tags: updatedTags,
            manualMetadataUpdatedAt: updatedAt
          }, manualGameMap);
        });
        entry.expiresAt = Date.now() + VIDEO_ASSETS_CACHE_TTL_MS;
      }

      return res.json({
        status: 'success',
        metadata: {
          customTitle: saved.custom_title || null,
          packageNames: updatedPackages,
          tags: updatedTags,
          updatedAt
        }
      });
    } catch (error) {
      if (error?.code === 'INVALID_PACKAGE_NAME') {
        return res.status(400).json({ error: error.message });
      }
      console.error('Video metadata update failed:', error);
      return res.status(500).json({ error: 'Unable to save video metadata.' });
    }
  });

  app.get('/api/video-assets', async (req, res) => {
    try {
      await initializeVideoMetadata(pool);
      const packageName = String(req.query.packageName || '').trim() || null;
      const cacheKey = packageName ? packageName.toLowerCase() : '__ALL__';
      const forceRefresh = req.query.refresh === '1' || req.query.force === 'true';

      const cached = !forceRefresh ? videoAssetsCache.get(cacheKey) : null;
      if (cached && cached.expiresAt > Date.now()) {
        res.set('Cache-Control', 'no-store');
        return res.json(cached.data);
      }

      const { rows } = await pool.query(`
        WITH asset_links AS (
          SELECT
            avl.asset_id,
            avl.creative_id,
            avl.creative_url,
            NULLIF(LOWER(avl.package_name), '') AS frame_package,
            NULLIF(LOWER(linked_game.package_name), '') AS linked_game_package,
            NULLIF(
              LOWER(COALESCE(NULLIF(ac.package_name, ''), creative_game.package_name)),
              ''
            ) AS creative_package,
            CASE
              WHEN cec.extraction_version IN (4, 5)
                AND cec.package_names IS NOT NULL
                AND jsonb_typeof(cec.package_names) = 'array'
                AND jsonb_array_length(cec.package_names) = 1
              THEN NULLIF(LOWER(cec.package_names ->> 0), '')
              ELSE NULL
            END AS cached_package
          FROM ad_video_links avl
          LEFT JOIN games linked_game
            ON linked_game.id = avl.game_id
          LEFT JOIN ad_creatives ac
            ON ac.creative_id = avl.creative_id
          LEFT JOIN games creative_game
            ON creative_game.id = ac.game_id
          LEFT JOIN creative_extraction_cache cec
            ON cec.creative_id = avl.creative_id
        ),
        asset_stats AS (
          SELECT
            al.asset_id,
            COUNT(DISTINCT al.creative_id)::int AS ad_count,
            ARRAY_AGG(DISTINCT al.creative_id ORDER BY al.creative_id)
              FILTER (WHERE al.creative_id IS NOT NULL) AS creative_ids,
            ARRAY_AGG(DISTINCT al.creative_url)
              FILTER (WHERE al.creative_url IS NOT NULL) AS creative_urls,
            COUNT(DISTINCT al.frame_package)::int AS strict_package_count
          FROM asset_links al
          GROUP BY al.asset_id
        ),
        asset_package_evidence AS (
          SELECT
            al.asset_id,
            pkg.package_name
          FROM asset_links al
          CROSS JOIN LATERAL (
            VALUES
              (al.frame_package),
              (al.linked_game_package),
              (al.creative_package),
              (al.cached_package)
          ) AS pkg(package_name)
          WHERE pkg.package_name IS NOT NULL
        ),
        asset_resolution AS (
          SELECT
            stats.asset_id,
            COUNT(DISTINCT evidence.package_name)::int AS linked_package_count,
            stats.strict_package_count,
            CASE
              WHEN COUNT(DISTINCT evidence.package_name) = 1
                THEN MIN(evidence.package_name)
              ELSE NULL
            END AS resolved_package
          FROM asset_stats stats
          LEFT JOIN asset_package_evidence evidence
            ON evidence.asset_id = stats.asset_id
          GROUP BY stats.asset_id, stats.strict_package_count
        )
        SELECT
          va.id,
          va.asset_key,
          va.source,
          va.youtube_id,
          va.youtube_url,
          va.thumbnail_url,
          va.media_url,
          va.media_url_expires_at,
          va.mime_type,
          va.duration_seconds,
          va.width,
          va.height,
          va.first_seen_at,
          va.last_seen_at,
          va.custom_title,
          va.manual_package_names,
          va.tags,
          va.manual_metadata_updated_at,
          resolution.linked_package_count,
          resolution.strict_package_count,
          resolution.resolved_package,
          stats.ad_count,
          stats.creative_ids,
          stats.creative_urls,
          CASE
            WHEN resolution.linked_package_count = 1 THEN
              JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
                'id', g.id,
                'title', COALESCE(g.title, g.package_name, resolution.resolved_package),
                'packageName', COALESCE(g.package_name, resolution.resolved_package),
                'publisherName', owner.publisher_name,
                'competitorName', owner.competitor_name,
                'icon', g.icon,
                'headerImage', g.header_image,
                'rating', g.rating,
                'installs', g.installs,
                'isPaid', g.is_paid,
                'priceText', g.price_text
              ))
            ELSE '[]'::jsonb
          END AS automatic_games
        FROM video_assets va
        JOIN asset_stats stats
          ON stats.asset_id = va.id
        JOIN asset_resolution resolution
          ON resolution.asset_id = va.id
        LEFT JOIN games g
          ON resolution.linked_package_count = 1
         AND LOWER(g.package_name) = resolution.resolved_package
        LEFT JOIN LATERAL (
          SELECT
            a.publisher_name,
            c.name AS competitor_name
          FROM account_games ag
          JOIN accounts a
            ON a.id = ag.account_id
          LEFT JOIN competitors c
            ON c.id = a.competitor_id
          WHERE ag.game_id = g.id
          ORDER BY a.id ASC
          LIMIT 1
        ) owner ON TRUE
        WHERE (
          $1::text IS NULL
          OR (
            resolution.linked_package_count = 1
            AND resolution.resolved_package = LOWER($1)
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(va.manual_package_names, '[]'::jsonb)) manual_pkg
            WHERE LOWER(manual_pkg.value) = LOWER($1)
          )
        )
        ORDER BY va.last_seen_at DESC, va.id DESC
      `, [packageName]);

      const manualPackageNames = [...new Set(rows.flatMap(row =>
        Array.isArray(row.manual_package_names)
          ? row.manual_package_names.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
          : []
      ))];

      const manualGameMap = new Map();
      if (manualPackageNames.length) {
        const { rows: gameRows } = await pool.query(`
          SELECT
            g.id,
            g.package_name,
            g.title,
            g.icon,
            g.header_image,
            g.rating,
            g.installs,
            g.is_paid,
            g.price_text,
            owner.publisher_name,
            owner.competitor_name
          FROM games g
          LEFT JOIN LATERAL (
            SELECT a.publisher_name, c.name AS competitor_name
            FROM account_games ag
            JOIN accounts a ON a.id = ag.account_id
            LEFT JOIN competitors c ON c.id = a.competitor_id
            WHERE ag.game_id = g.id
            ORDER BY a.id ASC
            LIMIT 1
          ) owner ON TRUE
          WHERE LOWER(g.package_name) = ANY($1::text[])
        `, [manualPackageNames]);

        for (const gameRow of gameRows) {
          manualGameMap.set(String(gameRow.package_name || '').toLowerCase(), toGame(gameRow, { manual: true }));
        }
      }

      const result = rows.map(row => {
        const expiresAt = row.media_url_expires_at || null;
        const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
        const linkedPackageCount = Number(row.linked_package_count) || 0;
        const strictPackageCount = Number(row.strict_package_count) || 0;
        const rawAutomaticGames = Array.isArray(row.automatic_games) ? row.automatic_games : [];
        const automaticGame = linkedPackageCount === 1
          ? toGame(rawAutomaticGames.find(game => game?.packageName) || null)
          : null;
        const associationState = linkedPackageCount === 1
          ? 'resolved'
          : linkedPackageCount > 1
            ? 'ambiguous'
            : 'unassigned';

        return buildVideoAssetDisplayFields({
          id: Number(row.id),
          assetKey: row.asset_key,
          source: row.source,
          youtubeId: row.youtube_id || null,
          youtubeUrl: row.youtube_url || null,
          thumbnailUrl: row.thumbnail_url || null,
          mediaUrl: row.media_url || null,
          mediaUrlExpiresAt: expiresAt,
          mediaUrlExpired: expired,
          mimeType: row.mime_type || null,
          durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
          width: row.width == null ? null : Number(row.width),
          height: row.height == null ? null : Number(row.height),
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          adCount: Number(row.ad_count) || 0,
          creativeIds: Array.isArray(row.creative_ids) ? row.creative_ids : [],
          creativeUrls: Array.isArray(row.creative_urls) ? row.creative_urls.filter(Boolean) : [],
          linkedPackageCount,
          associationState,
          associationSource: linkedPackageCount === 1
            ? (strictPackageCount > 0 ? 'frame' : 'ownership_consensus')
            : null,
          customTitle: row.custom_title || null,
          manualPackageNames: Array.isArray(row.manual_package_names) ? row.manual_package_names : [],
          tags: Array.isArray(row.tags) ? row.tags : [],
          manualMetadataUpdatedAt: row.manual_metadata_updated_at || null,
          automaticGames: automaticGame ? [automaticGame] : []
        }, manualGameMap);
      });

      videoAssetsCache.set(cacheKey, {
        expiresAt: Date.now() + VIDEO_ASSETS_CACHE_TTL_MS,
        data: result
      });

      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      console.error('Video library metadata fetch failed:', error);
      return res.status(500).json({ error: 'Unable to load video library.' });
    }
  });
}

module.exports = {
  initializeVideoMetadata,
  registerVideoMetadataRoutes,
  invalidateVideoMetadataCaches
};