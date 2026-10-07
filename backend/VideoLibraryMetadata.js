function registerVideoMetadataRoutes({ app, pool }) {
  app.get('/api/video-assets', async (req, res) => {
    try {
      const packageName = String(req.query.packageName || '').trim() || null;
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
              'title', COALESCE(
                g.title,
                NULLIF(ac.package_name, ''),
                NULLIF(avl.package_name, ''),
                g.package_name
              ),
              'packageName', COALESCE(
                NULLIF(ac.package_name, ''),
                NULLIF(avl.package_name, ''),
                g.package_name
              ),
              'publisherName', a.publisher_name,
              'competitorName', c.name,
              'icon', g.icon,
              'headerImage', g.header_image,
              'rating', g.rating,
              'installs', g.installs,
              'isPaid', g.is_paid,
              'priceText', g.price_text
            )) FILTER (
              WHERE COALESCE(
                NULLIF(ac.package_name, ''),
                NULLIF(avl.package_name, ''),
                g.package_name
              ) IS NOT NULL
            ),
            '[]'::jsonb
          ) AS games
        FROM video_assets va
        LEFT JOIN ad_video_links avl
          ON avl.asset_id = va.id
        LEFT JOIN ad_creatives ac
          ON ac.creative_id = avl.creative_id
        LEFT JOIN games g
          ON g.id = COALESCE(ac.game_id, avl.game_id)
          OR (
            COALESCE(ac.game_id, avl.game_id) IS NULL
            AND LOWER(g.package_name) = LOWER(COALESCE(
              NULLIF(ac.package_name, ''),
              NULLIF(avl.package_name, '')
            ))
          )
        LEFT JOIN account_games ag
          ON ag.game_id = g.id
        LEFT JOIN accounts a
          ON a.id = ag.account_id
        LEFT JOIN competitors c
          ON c.id = COALESCE(ac.competitor_id, avl.competitor_id, a.competitor_id)
        WHERE EXISTS (
          SELECT 1
          FROM ad_video_links live_link
          WHERE live_link.asset_id = va.id
        )
          AND (
            $1::text IS NULL
            OR EXISTS (
              SELECT 1
              FROM ad_video_links package_link
              LEFT JOIN ad_creatives package_creative
                ON package_creative.creative_id = package_link.creative_id
              LEFT JOIN games package_game
                ON package_game.id = COALESCE(package_creative.game_id, package_link.game_id)
              WHERE package_link.asset_id = va.id
                AND LOWER(COALESCE(
                  NULLIF(package_creative.package_name, ''),
                  NULLIF(package_link.package_name, ''),
                  package_game.package_name
                )) = LOWER($1)
            )
          )
        GROUP BY va.id
        ORDER BY va.last_seen_at DESC, va.id DESC
      `, [packageName]);

      const result = rows.map(row => {
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

      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      console.error('Video library metadata fetch failed:', error);
      return res.status(500).json({ error: 'Unable to load video library.' });
    }
  });
}

module.exports = {
  registerVideoMetadataRoutes
};
