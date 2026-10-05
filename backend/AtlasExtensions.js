const express = require('express');
const { Pool } = require('pg');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;
const {
  initializeIntelligenceFeatures,
  registerIntelligenceRoutes
} = require('./IntelligenceFeatures');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const extensionPool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

let initialized = false;
let registered = false;

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    await initializeIntelligenceFeatures(extensionPool);
    console.log('🎬 [Atlas Intelligence] Video library + keyword storage ready.');
  } catch (error) {
    initialized = false;
    console.error('⚠️ [Atlas Intelligence] Initialization failed:', error.message);
  }
}

// server_impl.js owns the Express app and database pool privately. Register the
// additive intelligence routes immediately before that app begins listening.
// At that point Atlas's existing /api authentication middleware is already in
// the stack, so these endpoints inherit the exact same access controls.
const originalListen = express.application.listen;
express.application.listen = function atlasExtensionListen(...args) {
  if (!registered) {
    registered = true;
    registerIntelligenceRoutes({ app: this, pool: extensionPool, gplay });
  }
  void initialize();
  return originalListen.apply(this, args);
};

void initialize();

module.exports = {
  extensionPool
};
