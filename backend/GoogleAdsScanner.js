// Load additive Atlas intelligence routes/storage before server.js creates its
// Express app. The extension hooks app.listen so the routes inherit Atlas's
// existing /api authentication middleware without changing server.js.
const { extensionPool } = require('./AtlasExtensions');
const scanner = require('./GoogleAdsScannerV2');

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
        AND avl.package_name = g.package_name;

      UPDATE ad_video_links avl
      SET competitor_id = a.competitor_id
      FROM games g
      JOIN account_games ag ON ag.game_id = g.id
      JOIN accounts a ON a.id = ag.account_id
      WHERE avl.competitor_id IS NULL
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
  // server.js processes the returned package list immediately after this
  // resolves, so defer the relationship pass slightly. The library query can
  // also join by package_name meanwhile, so there is no user-visible gap.
  setTimeout(() => { void reconcileVideoLinks(); }, 5000);
  return result;
}

module.exports = {
  ...scanner,
  scanCompetitor
};
