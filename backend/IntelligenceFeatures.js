const { analyzeGameKeywords } = require('./KeywordAnalyzer');

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
  `);
}

async function persistVideoAssets(pool, {
  creativeId,
  packageName,
  gameId,
  competitorId,
  assets
}) {
  if (!creativeId || !Array.isArray(assets) || assets.length === 0) return;

  const creativeUrl = competitorId
    ? `https://adstransparency.google.com/advertiser/creative/${creativeId}?region=any`
    : null;

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
    const expiresAt = rawAsset.mediaUrlExpiresAt
      ? new Date(rawAsset.mediaUrlExpiresAt)
      : null;

    const { rows } = await pool.query(
      `INSERT INTO video_assets (
         asset_key, source, youtube_id, youtube_url, thumbnail_url, media_url,
         media_url_expires_at, mime_type, duration_seconds, width, height,
         metadata, first_seen_at, last_seen_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12::jsonb, now(), now()
       )
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
        assetKey,
        source,
        youtubeId,
        youtubeUrl,
        thumbnailUrl,
        mediaUrl,
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
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (asset_id, creative_id, package_name) DO UPDATE SET
         game_id = COALESCE(EXCLUDED.game_id, ad_video_links.game_id),
         competitor_id = COALESCE(EXCLUDED.competitor_id, ad_video_links.competitor_id),
         creative_url = COALESCE(EXCLUDED.creative_url, ad_video_links.creative_url),
         last_seen_at = now()`,
      [assetId, creativeId, packageName || '', gameId || null, competitorId || null, creativeUrl]
    );
  }
}

async function getVideoLibrary(pool) {
  const { rows } = await pool.query(`
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
      COUNT(DISTINCT avl.creative_id)::int AS ad_count,
      ARRAY_AGG(DISTINCT avl.creative_id ORDER BY avl.creative_id)
        FILTER (WHERE avl.creative_id IS NOT NULL) AS creative_ids,
      COALESCE(
        JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
          'id', g.id,
          'title', COALESCE(g.title, avl.package_name),
          'packageName', avl.package_name,
          'publisherName', a.publisher_name,
          'competitorName', c.name,
          'icon', g.icon,
          'rating', g.rating,
          'installs', g.installs,
          'isPaid', g.is_paid,
          'priceText', g.price_text
        )) FILTER (WHERE avl.package_name IS NOT NULL),
        '[]'::jsonb
      ) AS games
    FROM video_assets va
    LEFT JOIN ad_video_links avl ON avl.asset_id = va.id
    LEFT JOIN games g ON g.id = avl.game_id
    LEFT JOIN account_games ag ON ag.game_id = g.id
    LEFT JOIN accounts a ON a.id = ag.account_id
    LEFT JOIN competitors c ON c.id = COALESCE(avl.competitor_id, a.competitor_id)
    GROUP BY va.id
    ORDER BY va.last_seen_at DESC, va.id DESC
  `);

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
      games: games.filter(game => game?.packageName)
    };
  });
}

async function getGameKeywordAnalysis(pool, gplay, gameId) {
  const { rows } = await pool.query(
    `SELECT id, package_name, title, short_description, description
     FROM games
     WHERE id = $1
     LIMIT 1`,
    [gameId]
  );

  if (rows.length === 0) return null;
  const game = rows[0];

  // Older rows predate short-description storage. Refresh once on demand so
  // the feature is useful immediately without waiting for the next ad scan.
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
     WHERE COALESCE(short_description, '') <> ''
        OR COALESCE(description, '') <> ''`
  );

  return analyzeGameKeywords({ game, corpus, limit: 30 });
}

function registerIntelligenceRoutes({ app, pool, gplay }) {
  app.get('/api/video-assets', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(await getVideoLibrary(pool));
    } catch (error) {
      console.error('Video library fetch failed:', error);
      return res.status(500).json({ error: 'Unable to load video library.' });
    }
  });

  app.get('/api/games/:id/keywords', async (req, res) => {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId) || gameId <= 0) {
      return res.status(400).json({ error: 'Invalid game ID.' });
    }

    try {
      const analysis = await getGameKeywordAnalysis(pool, gplay, gameId);
      if (!analysis) return res.status(404).json({ error: 'Game not found.' });
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
  registerIntelligenceRoutes,
  getAssetKey
};
