// Atlas backend feature wrapper.
//
// The existing server is preserved verbatim in serverCore.js. We intercept its
// final Express listen() call long enough to register modular intelligence
// routes, then start the exact same app/port. Keeping these features isolated
// avoids making the already-large core server harder to maintain.

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const { registerIntelligenceFeatures } = require('./AtlasIntelligenceFeatures');
const { registerKeywordPackageRoute } = require('./KeywordPackageRoute');

const originalListen = express.application.listen;
let atlasApp = null;
let listenArgs = null;

express.application.listen = function captureAtlasListen(...args) {
  atlasApp = this;
  listenArgs = args;
  // serverCore does not use the returned Server object after calling listen().
  // Return a harmless placeholder while the real listener is deferred.
  return null;
};

try {
  require('./serverCore');
} finally {
  express.application.listen = originalListen;
}

if (!atlasApp) {
  throw new Error('Atlas backend failed to initialize: Express app was not captured.');
}

try {
  registerIntelligenceFeatures(atlasApp);
  registerKeywordPackageRoute(atlasApp);
} catch (error) {
  console.error('⚠️ [Intelligence] Failed to register feature routes:', error);
}

originalListen.apply(atlasApp, listenArgs || [process.env.PORT || 3000, () => {
  console.log(`Atlas backend running on http://localhost:${process.env.PORT || 3000}`);
}]);
