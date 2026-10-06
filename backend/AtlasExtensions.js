const express = require('express');
const { Pool } = require('pg');
const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;
const {
  initializeIntelligenceFeatures,
  registerIntelligenceRoutes
} = require('./IntelligenceFeatures');
const {
  initializeVideoLifecycle,
  registerVideoLifecycleRoutes
} = require('./VideoLifecycle');

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
    await initializeVideoLifecycle(extensionPool);
    console.log('🎬 [Atlas Intelligence] Video library + keyword storage ready.');
  } catch (error) {
    initialized = false;
    console.error('⚠️ [Atlas Intelligence] Initialization failed:', error.message);
  }
}

const originalListen = express.application.listen;
express.application.listen = function atlasExtensionListen(...args) {
  if (!registered) {
    registered = true;
    registerIntelligenceRoutes({ app: this, pool: extensionPool, gplay });
    registerVideoLifecycleRoutes({ app: this, pool: extensionPool });
  }
  void initialize();
  return originalListen.apply(this, args);
};

void initialize();

module.exports = {
  extensionPool
};
