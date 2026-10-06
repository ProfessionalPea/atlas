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

function registerVideoLifecycleRoutes({ app, pool }) {
  // Admin-only automatically because Atlas's existing /api middleware has
  // already been registered before extension routes are attached.
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
  clearVideoLibrary
};
