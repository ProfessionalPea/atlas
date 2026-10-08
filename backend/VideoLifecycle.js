async function initializeVideoLifecycle(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION atlas_cleanup_competitor_video_data()
    RETURNS trigger AS $$
    DECLARE
      affected_creatives TEXT[];
    BEGIN
      SELECT ARRAY(
        SELECT DISTINCT creative_id
        FROM (
          SELECT creative_id
          FROM ad_creatives
          WHERE competitor_id = OLD.id

          UNION

          SELECT creative_id
          FROM ad_video_links
          WHERE competitor_id = OLD.id
        ) ids
        WHERE creative_id IS NOT NULL AND creative_id <> ''
      ) INTO affected_creatives;

      IF COALESCE(array_length(affected_creatives, 1), 0) > 0 THEN
        DELETE FROM creative_extraction_cache
        WHERE creative_id = ANY(affected_creatives);

        DELETE FROM ad_video_links
        WHERE competitor_id = OLD.id
           OR creative_id = ANY(affected_creatives);
      ELSE
        DELETE FROM ad_video_links
        WHERE competitor_id = OLD.id;
      END IF;

      -- A video asset may be reused by another competitor. Delete the asset
      -- itself only when no surviving creative still references it.
      DELETE FROM video_assets va
      WHERE NOT EXISTS (
        SELECT 1
        FROM ad_video_links avl
        WHERE avl.asset_id = va.id
      );

      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_atlas_cleanup_competitor_video_data ON competitors;
    CREATE TRIGGER trg_atlas_cleanup_competitor_video_data
    BEFORE DELETE ON competitors
    FOR EACH ROW
    EXECUTE FUNCTION atlas_cleanup_competitor_video_data();
  `);
}

async function clearVideoLibrary(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM video_assets) AS videos,
        (SELECT COUNT(*)::int FROM ad_video_links) AS links,
        (SELECT COUNT(*)::int FROM creative_extraction_cache) AS cache_entries
    `);

    await client.query(`
      TRUNCATE TABLE
        ad_video_links,
        video_assets,
        creative_extraction_cache
      RESTART IDENTITY;
    `);

    await client.query('COMMIT');
    return counts.rows[0] || { videos: 0, links: 0, cache_entries: 0 };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function deleteVideoAsset(pool, assetId) {
  const id = Number(assetId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error('Invalid video asset id.');
    error.code = 'INVALID_VIDEO_ASSET_ID';
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assetResult = await client.query(`
      SELECT
        va.id,
        va.asset_key,
        va.source,
        va.youtube_id,
        (
          SELECT COUNT(*)::int
          FROM ad_video_links avl
          WHERE avl.asset_id = va.id
        ) AS link_count
      FROM video_assets va
      WHERE va.id = $1
      FOR UPDATE
    `, [id]);

    const asset = assetResult.rows[0];
    if (!asset) {
      await client.query('ROLLBACK');
      return null;
    }

    // ad_video_links.asset_id uses ON DELETE CASCADE, so deleting the asset
    // removes only this video's relationships without touching the ad creative,
    // game, publisher, competitor, or extraction cache records.
    await client.query('DELETE FROM video_assets WHERE id = $1', [id]);
    await client.query('COMMIT');

    return {
      id: Number(asset.id),
      assetKey: asset.asset_key,
      source: asset.source,
      youtubeId: asset.youtube_id || null,
      links: Number(asset.link_count) || 0
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function registerVideoLifecycleRoutes({ app, pool }) {
  // Admin-only automatically because Atlas's existing /api middleware has
  // already been registered before extension routes are attached.
  app.delete('/api/video-assets/:assetId', async (req, res) => {
    try {
      const deleted = await deleteVideoAsset(pool, req.params.assetId);
      if (!deleted) {
        return res.status(404).json({ error: 'Video asset not found.' });
      }

      return res.json({
        status: 'success',
        message: 'Video asset deleted.',
        deleted
      });
    } catch (error) {
      if (error?.code === 'INVALID_VIDEO_ASSET_ID') {
        return res.status(400).json({ error: error.message });
      }
      console.error('Video asset delete failed:', error);
      return res.status(500).json({ error: 'Unable to delete video asset.' });
    }
  });

  app.delete('/api/video-assets', async (_req, res) => {
    try {
      const deleted = await clearVideoLibrary(pool);
      return res.json({
        status: 'success',
        message: 'Video Library and creative extraction cache cleared.',
        deleted: {
          videos: Number(deleted.videos) || 0,
          links: Number(deleted.links) || 0,
          cacheEntries: Number(deleted.cache_entries) || 0
        }
      });
    } catch (error) {
      console.error('Video Library reset failed:', error);
      return res.status(500).json({ error: 'Unable to clear Video Library.' });
    }
  });
}

module.exports = {
  initializeVideoLifecycle,
  registerVideoLifecycleRoutes,
  clearVideoLibrary,
  deleteVideoAsset
};
