function registerVideoMetadataRoutes({ app, pool }) {
  app.get('/api/video-assets', async (req, res) => {
    try {
      const packageName = String(req.query.packageName || '').trim() || null;
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
              WHEN cec.package_names IS NOT NULL
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
        asset_package_evidence AS (
          SELECT asset_id, frame_package AS package_name, 'frame'::text AS source
          FROM asset_links
          WHERE frame_package IS NOT NULL

          UNION ALL

          SELECT asset_id, linked_game_package AS package_name, 'linked_game'::text AS source
          FROM asset_links
          WHERE linked_game_package IS NOT NULL

          UNION ALL

          SELECT asset_id, creative_package AS package_name, 'creative'::text AS source
          FROM asset_links
          WHERE creative_package IS NOT NULL

          UNION ALL

          SELECT asset_id, cached_package AS package_name, 'cache'::text AS source
          FROM asset_links
          WHERE cached_package IS NOT NULL
        ),
        asset_resolution AS (
          SELECT
            ids.asset_id,
            COUNT(DISTINCT evidence.package_name)::int AS linked_package_count,
            COUNT(DISTINCT evidence.package_name)
              FILTER (WHERE evidence.source = 'frame')::int AS strict_package_count,
            CASE
              WHEN COUNT(DISTINCT evidence.package_name) = 1
                THEN MIN(evidence.package_name)
              ELSE NULL
            END AS resolved_package
          FROM (SELECT DISTINCT asset_id FROM asset_links) ids
          LEFT JOIN asset_package_evidence evidence
            ON evidence.asset_id = ids.asset_id
          GROUP BY ids.asset_id
        ),
        asset_stats AS (
          SELECT
            avl.asset_id,
            COUNT(DISTINCT avl.creative_id)::int AS ad_count,
            ARRAY_AGG(DISTINCT avl.creative_id ORDER BY avl.creative_id)
              FILTER (WHERE avl.creative_id IS NOT NULL) AS creative_ids,
            ARRAY_AGG(DISTINCT avl.creative_url)
              FILTER (WHERE avl.creative_url IS NOT NULL) AS creative_urls
          FROM ad_video_links avl
          GROUP BY avl.asset_id
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
          resolution.linked_package_count,
          resolution.strict_package_count,
          resolution.resolved_package,
          stats.ad_count,
          stats.creative_ids,
          stats.creative_urls,
          CASE
            WHEN resolution.linked_package_count = 1 AND g.id IS NOT NULL THEN
              JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
                'id', g.id,
                'title', COALESCE(g.title, g.package_name),
                'packageName', g.package_name,
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
          END AS games
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
        )
        ORDER BY va.last_seen_at DESC, va.id DESC
      `, [packageName]);

      const result = rows.map(row => {
        const expiresAt = row.media_url_expires_at || null;
        const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
        const linkedPackageCount = Number(row.linked_package_count) || 0;
        const strictPackageCount = Number(row.strict_package_count) || 0;
        const rawGames = Array.isArray(row.games) ? row.games : [];
        const resolvedGame = linkedPackageCount === 1
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
          associationSource: linkedPackageCount === 1
            ? (strictPackageCount > 0 ? 'frame' : 'ownership_consensus')
            : null,
          games: resolvedGame ? [resolvedGame] : []
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
