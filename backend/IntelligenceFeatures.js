const { analyzeGameKeywords } = require('./KeywordAnalyzer');

const VIDEO_ATTRIBUTION_VERSION = 2;
const clearedCreativeLinks = new Set();

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return null;
}

function stableMediaKey(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return normalized.split('?')[0];
  }
}

function getAssetKey(asset) {
  if (asset?.youtubeId) return `youtube:${asset.youtubeId}`;
  const stable = stableMediaKey(asset?.mediaUrl);
  if (stable) return `media:${stable}`;
  if (asset?.thumbnailUrl) return `thumbnail:${asset.thumbnailUrl}`;
  return null;
}

async function initializeIntelligenceFeatures(pool) {
  await pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS short_description TEXT;

    CREATE TABLE IF NOT EXISTS video_assets (
      id BIGSERIAL PRIMARY KEY,
      asset_key TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL DEFAULT 'direct',
      youtube_id TEXT,
      youtube_url TEXT,
      thumbnail_url TEXT,
      media_url TEXT,
      media_url_expires_at TIMESTAMPTZ,
      mime_type TEXT,
      duration_seconds NUMERIC(10,3),
      width INTEGER,
      height INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_video_assets_last_seen
      ON video_assets(last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS ad_video_links (
      asset_id BIGINT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      creative_id TEXT NOT NULL,
      package_name TEXT,
      game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
      competitor_id INTEGER REFERENCES competitors(id) ON DELETE SET NULL,
      creative_url TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (asset_id, creative_id, package_name)
    );

    CREATE INDEX IF NOT EXISTS idx_ad_video_links_package
      ON ad_video_links(package_name);

    CREATE INDEX IF NOT EXISTS idx_ad_video_links_competitor
      ON ad_video_links(competitor_id);

    CREATE TABLE IF NOT EXISTS creative_extraction_cache (
      creative_id TEXT PRIMARY KEY,
      package_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      video_checked_at TIMESTAMPTZ,
      last_deep_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_video_count INTEGER NOT NULL DEFAULT 0,
      extraction_version INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE creative_extraction_cache
      ADD COLUMN IF NOT EXISTS extraction_version INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_creative_extraction_cache_checked
      ON creative_extraction_cache(video_checked_at DESC);
  `);
}

async function resetStaleCreativeLinks(pool, creativeId) {
  const id = String(creativeId || '').trim();
  if (!id || clearedCreativeLinks.has(id)) return;

  const { rows } = await pool.query(
    `SELECT extraction_version
     FROM creative_extraction_cache
     WHERE creative_id = $1
     LIMIT 1`,
    [id]
  );

  const storedVersion = Number(rows[0]?.extraction_version) || 0;
  if (storedVersion !== VIDEO_ATTRIBUTION_VERSION) {
    await pool.query(`DELETE FROM ad_video_links WHERE creative_id = $1`, [id]);
  }

  clearedCreativeLinks.add(id);
}

async function persistVideoAssets(pool, {
  creativeId,
  packageName,
  gameId,
  competitorId,
  advertiserId,
  creativeUrl: explicitCreativeUrl,
  assets
}) {
  if (!creativeId || !Array.isArray(assets) || assets.length === 0) return;

  await resetStaleCreativeLinks(pool, creativeId);

  const creativeUrl = explicitCreativeUrl || (advertiserId
    ? `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=any`
    : null);

  for (const rawAsset of assets) {
    const assetKey = getAssetKey(rawAsset);
    if (!assetKey) continue;

    const source = rawAsset.youtubeId || rawAsset.source === 'youtube' ? 'youtube' : 'direct';
    const youtubeId = rawAsset.youtubeId || null;
    const youtubeUrl = youtubeId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`
      : normalizeHttpUrl(rawAsset.youtubeUrl);
    const thumbnailUrl = normalizeHttpUrl(rawAsset.thumbnailUrl);
    const mediaUrl = normalizeHttpUrl(rawAsset.mediaUrl);
    const expiresAt = rawAsset.mediaUrlExpiresAt ? new Date(rawAsset.mediaUrlExpiresAt) : null;

    const { rows } = await pool.query(
      `INSERT INTO video_assets (
         asset_key, source, youtube_id, youtube_url, thumbnail_url, media_url,
         media_url_expires_at, mime_type, duration_seconds, width, height,
         metadata, first_seen_at, last_seen_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now(),now())
       ON CONFLICT (asset_key) DO UPDATE SET
         source = EXCLUDED.source,
         youtube_id = COALESCE(EXCLUDED.youtube_id, video_assets.youtube_id),
         youtube_url = COALESCE(EXCLUDED.youtube_url, video_assets.youtube_url),
         thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, video_assets.thumbnail_url),
         media_url = COALESCE(EXCLUDED.media_url, video_assets.media_url),
         media_url_expires_at = COALESCE(EXCLUDED.media_url_expires_at, video_assets.media_url_expires_at),
         mime_type = COALESCE(EXCLUDED.mime_type, video_assets.mime_type),
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, video_assets.duration_seconds),
         width = COALESCE(EXCLUDED.width, video_assets.width),
         height = COALESCE(EXCLUDED.height, video_assets.height),
         metadata = video_assets.metadata || EXCLUDED.metadata,
         last_seen_at = now()
       RETURNING id`,
      [
        assetKey, source, youtubeId, youtubeUrl, thumbnailUrl, mediaUrl,
        Number.isNaN(expiresAt?.getTime?.()) ? null : expiresAt,
        rawAsset.mimeType || null,
        Number.isFinite(Number(rawAsset.durationSeconds)) ? Number(rawAsset.durationSeconds) : null,
        Number.isFinite(Number(rawAsset.width)) ? Number(rawAsset.width) : null,
        Number.isFinite(Number(rawAsset.height)) ? Number(rawAsset.height) : null,
        JSON.stringify(rawAsset.metadata || {})
      ]
    );

    const assetId = rows[0]?.id;
    if (!assetId) continue;

    await pool.query(
      `INSERT INTO ad_video_links (
         asset_id, creative_id, package_name, game_id, competitor_id,
         creative_url, first_seen_at, last_seen_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,now(),now())
       ON CONFLICT (asset_id, creative_id, package_name) DO UPDATE SET
         game_id = COALESCE(EXCLUDED.game_id, ad_video_links.game_id),
         competitor_id = COALESCE(EXCLUDED.competitor_id, ad_video_links.competitor_id),
         creative_url = COALESCE(EXCLUDED.creative_url, ad_video_links.creative_url),
         last_seen_at = now()`,
      [assetId, creativeId, packageName || '', gameId || null, competitorId || null, creativeUrl]
    );
  }
}

async function getCreativeExtractionCache(pool, creativeIds) {
  const ids = Array.isArray(creativeIds)
    ? creativeIds.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (!ids.length) return new Map();

  const { rows } = await pool.query(
    `SELECT creative_id, package_names, video_checked_at, last_deep_scanned_at,
            last_video_count, extraction_version
     FROM creative_extraction_cache
     WHERE creative_id = ANY($1::text[])`,
    [ids]
  );

  return new Map(rows.map(row => {
    const extractionVersion = Number(row.extraction_version) || 0;
    const isCurrent = extractionVersion === VIDEO_ATTRIBUTION_VERSION;
    return [row.creative_id, {
      creativeId: row.creative_id,
      packageNames: Array.isArray(row.package_names) ? row.package_names.filter(Boolean) : [],
      videoCheckedAt: isCurrent ? (row.video_checked_at || null) : null,
      lastDeepScannedAt: row.last_deep_scanned_at || null,
      videoCount: Number(row.last_video_count) || 0,
      extractionVersion
    }];
  }));
}

async function collapseAmbiguousCreativeLinks(pool, creativeId) {
  const id = String(creativeId || '').trim();
  if (!id) return;

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (asset_id)
       asset_id, creative_id, competitor_id, creative_url, first_seen_at, last_seen_at
     FROM ad_video_links
     WHERE creative_id = $1
     ORDER BY asset_id, last_seen_at DESC`,
    [id]
  );

  for (const row of rows) {
    await pool.query(
      `INSERT INTO ad_video_links (
         asset_id, creative_id, package_name, game_id, competitor_id,
         creative_url, first_seen_at, last_seen_at
       )
       VALUES ($1,$2,'',NULL,$3,$4,$5,$6)
       ON CONFLICT (asset_id, creative_id, package_name) DO UPDATE SET
         game_id = NULL,
         competitor_id = COALESCE(EXCLUDED.competitor_id, ad_video_links.competitor_id),
         creative_url = COALESCE(EXCLUDED.creative_url, ad_video_links.creative_url),
         first_seen_at = LEAST(ad_video_links.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = GREATEST(ad_video_links.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        row.asset_id,
        row.creative_id,
        row.competitor_id || null,
        row.creative_url || null,
        row.first_seen_at || new Date(),
        row.last_seen_at || new Date()
      ]
    );
  }

  await pool.query(
    `DELETE FROM ad_video_links
     WHERE creative_id = $1 AND COALESCE(package_name, '') <> ''`,
    [id]
  );
}

async function persistCreativeExtractionCache(pool, {
  creativeId,
  packageNames = [],
  videoCount = 0
}) {
  const id = String(creativeId || '').trim();
  if (!id) return;

  const normalizedPackages = [...new Set(
    (Array.isArray(packageNames) ? packageNames : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];

  // A creative that exposes more than one mobile package is ambiguous: the
  // page can contain recommendation/companion links that do not own the video.
  // Keep the asset in the global Video Library, but do not claim it belongs to
  // any individual game. A later, more precise extractor can safely rebuild it.
  if (normalizedPackages.length > 1 && Number(videoCount) > 0) {
    await collapseAmbiguousCreativeLinks(pool, id);
  } else if (normalizedPackages.length === 0 || Number(videoCount) <= 0) {
    // If the fresh deep scan no longer sees a usable video/package pairing,
    // remove historical links so stale attribution cannot survive forever.
    await pool.query(`DELETE FROM ad_video_links WHERE creative_id = $1`, [id]);
  }

  await pool.query(
    `INSERT INTO creative_extraction_cache (
       creative_id, package_names, video_checked_at, last_deep_scanned_at,
       last_video_count, extraction_version
     )
     VALUES ($1, $2::jsonb, now(), now(), $3, $4)
     ON CONFLICT (creative_id) DO UPDATE SET
       package_names = EXCLUDED.package_names,
       video_checked_at = now(),
       last_deep_scanned_at = now(),
       last_video_count = EXCLUDED.last_video_count,
       extraction_version = EXCLUDED.extraction_version`,
    [
      id,
      JSON.stringify(normalizedPackages),
      Math.max(0, Number(videoCount) || 0),
      VIDEO_ATTRIBUTION_VERSION
    ]
  );

  clearedCreativeLinks.delete(id);
}

async function touchCreativeVideoAssets(pool, creativeId) {
  const id = String(creativeId || '').trim();
  if (!id) return;

  await pool.query(
    `WITH touched AS (
       UPDATE ad_video_links
       SET last_seen_at = now()
       WHERE creative_id = $1
       RETURNING asset_id
     )
     UPDATE video_assets va
     SET last_seen_at = now()
     WHERE va.id IN (SELECT asset_id FROM touched)`,
    [id]
  );
}

async function getVideoLibrary(pool, packageName = null) {
  const { rows } = await pool.query(`
    SELECT
      va.id, va.asset_key, va.source, va.youtube_id, va.youtube_url,
      va.thumbnail_url, va.media_url, va.media_url_expires_at, va.mime_type,
      va.duration_seconds, va.width, va.height, va.first_seen_at, va.last_seen_at,
      COUNT(DISTINCT avl.creative_id)::int AS ad_count,
      ARRAY_AGG(DISTINCT avl.creative_id ORDER BY avl.creative_id)
        FILTER (WHERE avl.creative_id IS NOT NULL) AS creative_ids,
      ARRAY_AGG(DISTINCT avl.creative_url)
        FILTER (WHERE avl.creative_url IS NOT NULL) AS creative_urls,
      COALESCE(
        JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
          'id', g.id,
          'title', COALESCE(g.title, avl.package_name),
          'packageName', avl.package_name,
          'publisherName', a.publisher_name,
          'competitorName', c.name,
          'icon', g.icon,
          'headerImage', g.header_image,
          'rating', g.rating,
          'installs', g.installs,
          'isPaid', g.is_paid,
          'priceText', g.price_text
        )) FILTER (WHERE NULLIF(avl.package_name, '') IS NOT NULL),
        '[]'::jsonb
      ) AS games
    FROM video_assets va
    LEFT JOIN ad_video_links avl ON avl.asset_id = va.id
    LEFT JOIN games g
      ON g.id = avl.game_id
      OR (avl.game_id IS NULL AND g.package_name = avl.package_name)
    LEFT JOIN account_games ag ON ag.game_id = g.id
    LEFT JOIN accounts a ON a.id = ag.account_id
    LEFT JOIN competitors c ON c.id = COALESCE(avl.competitor_id, a.competitor_id)
    WHERE EXISTS (
      SELECT 1 FROM ad_video_links live_link WHERE live_link.asset_id = va.id
    )
      AND (
        $1::text IS NULL
        OR EXISTS (
          SELECT 1
          FROM ad_video_links package_link
          WHERE package_link.asset_id = va.id
            AND LOWER(package_link.package_name) = LOWER($1)
            AND NOT EXISTS (
              SELECT 1
              FROM ad_video_links competing_link
              WHERE competing_link.asset_id = package_link.asset_id
                AND competing_link.creative_id = package_link.creative_id
                AND COALESCE(competing_link.package_name, '') <> ''
                AND LOWER(competing_link.package_name) <> LOWER(package_link.package_name)
            )
        )
      )
    GROUP BY va.id
    ORDER BY va.last_seen_at DESC, va.id DESC
  `, [packageName ? String(packageName).trim() : null]);

  return rows.map(row => {
    const expiresAt = row.media_url_expires_at || null;
    const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
    const games = Array.isArray(row.games) ? row.games : [];
    return {
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
      games: games.filter(game => game?.packageName)
    };
  });
}

async function loadKeywordGame(pool, selector, value) {
  const byId = selector === 'id';
  const query = byId
    ? `SELECT id, package_name, title, short_description, description FROM games WHERE id = $1 LIMIT 1`
    : `SELECT id, package_name, title, short_description, description FROM games WHERE package_name = $1 LIMIT 1`;
  const { rows } = await pool.query(query, [value]);
  return rows[0] || null;
}

async function getGameKeywordAnalysis(pool, gplay, selector, value) {
  const game = await loadKeywordGame(pool, selector, value);
  if (!game) return null;

  // Older rows predate short-description storage. Refresh once on demand so
  // the feature becomes useful immediately, without waiting for another ad scan.
  if (!game.short_description && game.package_name) {
    try {
      const appData = await gplay.app({ appId: game.package_name, country: 'us', lang: 'en' });
      game.short_description = appData?.summary || '';
      game.description = appData?.description || game.description || '';
      await pool.query(
        `UPDATE games
         SET short_description = COALESCE(NULLIF($2, ''), short_description),
             description = COALESCE(NULLIF($3, ''), description)
         WHERE id = $1`,
        [game.id, game.short_description, game.description]
      );
    } catch (error) {
      console.warn('Keyword metadata refresh failed:', game.package_name, error.message);
    }
  }

  const { rows: corpus } = await pool.query(
    `SELECT package_name, short_description, description
     FROM games
     WHERE COALESCE(short_description, '') <> '' OR COALESCE(description, '') <> ''`
  );

  return analyzeGameKeywords({ game, corpus, limit: 30 });
}

function registerIntelligenceRoutes({ app, pool, gplay }) {
  app.get('/api/video-assets', async (req, res) => {
    try {
      const packageName = String(req.query.packageName || '').trim() || null;
      res.set('Cache-Control', 'no-store');
      return res.json(await getVideoLibrary(pool, packageName));
    } catch (error) {
      console.error('Video library fetch failed:', error);
      return res.status(500).json({ error: 'Unable to load video library.' });
    }
  });

  app.get('/api/games/:id/keywords', async (req, res) => {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId) || gameId <= 0) return res.status(400).json({ error: 'Invalid game ID.' });
    try {
      const analysis = await getGameKeywordAnalysis(pool, gplay, 'id', gameId);
      if (!analysis) return res.status(404).json({ error: 'Game not found.' });
      res.set('Cache-Control', 'no-store');
      return res.json(analysis);
    } catch (error) {
      console.error('Keyword analysis failed:', error);
      return res.status(500).json({ error: 'Unable to analyze game descriptions.' });
    }
  });

  app.get('/api/game-keywords', async (req, res) => {
    const packageName = String(req.query.packageName || '').trim();
    if (!packageName) return res.status(400).json({ error: 'Package name is required.' });
    try {
      const analysis = await getGameKeywordAnalysis(pool, gplay, 'package', packageName);
      if (!analysis) return res.status(404).json({ error: 'Game not found in Atlas.' });
      res.set('Cache-Control', 'no-store');
      return res.json(analysis);
    } catch (error) {
      console.error('Keyword analysis failed:', error);
      return res.status(500).json({ error: 'Unable to analyze game descriptions.' });
    }
  });
}

module.exports = {
  initializeIntelligenceFeatures,
  persistVideoAssets,
  getCreativeExtractionCache,
  persistCreativeExtractionCache,
  touchCreativeVideoAssets,
  registerIntelligenceRoutes,
  getAssetKey,
  VIDEO_ATTRIBUTION_VERSION
};