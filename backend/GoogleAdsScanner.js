// Load additive Atlas intelligence routes/storage before server.js creates its
// Express app. The extension hooks app.listen so the routes inherit Atlas's
// existing /api authentication middleware without changing server.js.
const { extensionPool } = require('./AtlasExtensions');
const scanner = require('./GoogleAdsScannerV3');

async function initializeCreativeOwnershipAccounting() {
  try {
    // games.ad_count used to be increment-only, so one creative accidentally
    // attributed to several packages permanently inflated every affected game.
    // Keep the display counter derived from the actual creative ownership table
    // instead. Moving/deleting a creative automatically repairs both old/new
    // owners as v4 re-resolves historical creatives.
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
  const result = await scanner.scanCompetitor(...args);
  // server.js processes returned packages immediately after this resolves. The
  // relationship pass is best-effort; package-filtered Video Library queries
  // can already join by package_name in the meantime.
  setTimeout(() => { void reconcileVideoLinks(); }, 5000);
  setTimeout(() => { void reconcileVideoLinks(); }, 30000);
  return result;
}

module.exports = {
  ...scanner,
  scanCompetitor
};
