// Load additive Atlas intelligence routes/storage before server.js creates its
// Express app. The extension hooks app.listen so the routes inherit Atlas's
// existing /api authentication middleware without changing server.js.
require('./AtlasExtensions');

// Compatibility entry point. The V2 scanner adds video-creative extraction
// while preserving the scanCompetitor contract used by Atlas.
module.exports = require('./GoogleAdsScannerV2');
