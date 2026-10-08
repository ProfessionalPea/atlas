function registerVideoMetadataRoutes({ app, pool }) {
  app.get('/api/video-assets', async (req, res) => {
    try {
      const packageName = String(req.query.packageName || '').trim() || null;
      const { rows } = await pool.query(`
        WITH asset_link_summary AS (
          SELECT
            asset_id,
            COUNT(DISTINCT NULLIF(LOWER(package_name), ''))::int AS linked_package_count
          FROM ad_video_links
          GROUP BY asset_id
        )
        SELECT
          va.id, va.asset_key, va.source, va.youtube_id, va.youtube_url,
          va.thumbnail_url, va.media_url, va.media_url_expires_at, va.mime_type,
          va.duration_seconds, va.width, va.height, va.first_seen_at, va.last_seen_at,
          als.linked_package_count,
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
                NULLIF(avl.package_name, ''),
                g.package_name
              ),
              'packageName', COALESCE(
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
              WHERE als.linked_package_count = 1
                AND NULLIF(avl.package_name, '') IS NOT NULL
            ),
            '[]'::jsonb
          ) AS games
        FROM video_assets va
        JOIN asset_link_summary als
          ON als.asset_id = va.id
        LEFT JOIN ad_video_links avl
          ON avl.asset_id = va.id
        LEFT JOIN games g
          ON g.id = avl.game_id
          OR (
            avl.game_id IS NULL
            AND NULLIF(avl.package_name, '') IS NOT NULL
            AND LOWER(g.package_name) = LOWER(avl.package_name)
          )
        LEFT JOIN account_games ag
          ON ag.game_id = g.id
        LEFT JOIN accounts a
          ON a.id = ag.account_id
        LEFT JOIN competitors c
          ON c.id = COALESCE(avl.competitor_id, a.competitor_id)
        WHERE EXISTS (
          SELECT 1
          FROM ad_video_links live_link
          WHERE live_link.asset_id = va.id
        )
          AND (
            $1::text IS NULL
            OR (
              als.linked_package_count = 1
              AND EXISTS (
                SELECT 1
                FROM ad_video_links package_link
                WHERE package_link.asset_id = va.id
                  AND NULLIF(package_link.package_name, '') IS NOT NULL
                  AND LOWER(package_link.package_name) = LOWER($1)
              )
            )
          )
        GROUP BY va.id, als.linked_package_count
        ORDER BY va.last_seen_at DESC, va.id DESC
      `, [packageName]);

      const result = rows.map(row => {
        const expiresAt = row.media_url_expires_at || null;
        const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
        const linkedPackageCount = Number(row.linked_package_count) || 0;
        const rawGames = Array.isArray(row.games) ? row.games : [];

        // A Video Library card is allowed to claim a game only when the
        // frame-scoped video link itself resolved to exactly one package across
        // the asset's active links. Creative-level ownership is deliberately
        // not used as a fallback: a creative can contain unrelated videos in
        // sibling/main frames, which is exactly what strict attribution is
        // intended to prevent.
        const strictGame = linkedPackageCount === 1
          ? rawGames.find(game => game?.packageName) || null
          : null;

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
          linkedPackageCount,
          associationState: linkedPackageCount === 1
            ? 'resolved'
            : linkedPackageCount > 1
              ? 'ambiguous'
              : 'unassigned',
          games: strictGame ? [strictGame] : []
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
