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
const {
  initializeVideoMetadata,
  registerVideoMetadataRoutes
} = require('./VideoLibraryMetadata');
const {
  beginScan,
  mergeScanStatus
} = require('./ScanDiscoveryRegistry');

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const extensionPool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

let initialized = false;
let registered = false;

// server.js historically builds the Latest dashboard package list only from
// creatives that have one canonical owner. Scanner v6 deliberately discovers
// real secondary packages without assigning the ad to them. Because this module
// is loaded before server.js registers its Express routes, wrap just the scan
// start/status routes so the UI receives every validated discovered package
// while the legacy ad-counting loop still sees canonical results only.
const SCAN_STATUS_BRIDGE = Symbol.for('atlas.scanStatusDiscoveryBridge');
if (!express.application[SCAN_STATUS_BRIDGE]) {
  express.application[SCAN_STATUS_BRIDGE] = true;

  const originalPost = express.application.post;
  express.application.post = function atlasDiscoveryPost(path, ...handlers) {
    if (path === '/api/scan') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function atlasScanStartBridge(req, res, next) {
          const originalJson = res.json.bind(res);
          res.json = body => {
            if (body?.status === 'initiated' && body?.scanId) beginScan(body.scanId);
            res.json = originalJson;
            return originalJson(body);
          };
          return handler(req, res, next);
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  const originalGet = express.application.get;
  express.application.get = function atlasDiscoveryGet(path, ...handlers) {
    if (path === '/api/scan-status') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function atlasScanStatusBridge(req, res, next) {
          const originalJson = res.json.bind(res);
          res.json = body => {
            res.json = originalJson;
            return originalJson(mergeScanStatus(body));
          };
          return handler(req, res, next);
        };
      });
    }
    return originalGet.call(this, path, ...handlers);
  };
}

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    await initializeIntelligenceFeatures(extensionPool);
    await initializeVideoLifecycle(extensionPool);
    await initializeVideoMetadata(extensionPool);
    console.log('🎬 [Atlas Intelligence] Video library + editable metadata + keyword storage ready.');
  } catch (error) {
    initialized = false;
    console.error('⚠️ [Atlas Intelligence] Initialization failed:', error.message);
  }
}

const originalListen = express.application.listen;
express.application.listen = function atlasExtensionListen(...args) {
  if (!registered) {
    registered = true;
    registerVideoMetadataRoutes({ app: this, pool: extensionPool });
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
