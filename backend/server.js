require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { generateAndSendReport } = require("./AutomatedReport");
const { scanCompetitor } = require("./GoogleAdsScanner");
const { pushScanToSheets, syncPublisherLinksToSheets } = require("./GoogleSheetsSync"); 
const express = require("express");
const cors = require("cors");
const { Pool } = require('pg');
const crypto = require('crypto');

// Strip ?sslmode=... from the URL so it doesn't overwrite rejectUnauthorized: false
const cleanConnectionString = (process.env.DATABASE_URL || "").split("?")[0];

const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

// Auto-initialize users table and default role accounts
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'view-only',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const adminCheck = await pool.query("SELECT id FROM users WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
      const defaultAdminHash = crypto.createHash("sha256").update("admin@gss").digest("hex");
      const defaultUserHash = crypto.createHash("sha256").update("user123").digest("hex");
      await pool.query(`
        INSERT INTO users (username, password_hash, role)
        VALUES
          ('admin', $1, 'full access'),
          ('user', $2, 'view-only')
        ON CONFLICT (username) DO NOTHING;
      `, [defaultAdminHash, defaultUserHash]);
      console.log("👤 [AUTH] Seeded default accounts: admin (admin@gss) and user (user123)");
    }
  } catch (e) {
    console.error("⚠️ [AUTH] Failed to initialize users table:", e.message);
  }
})();

// Auto-initialize the ad_creatives table. It records every ad (creative) ID
// Atlas has ever seen so a re-scan can tell "still running" apart from "new",
// instead of re-counting the same ad every time it's scanned again.
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ad_creatives (
        creative_id   TEXT PRIMARY KEY,
        game_id       INTEGER REFERENCES games(id) ON DELETE CASCADE,
        competitor_id INTEGER REFERENCES competitors(id) ON DELETE CASCADE,
        package_name  TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } catch (e) {
    console.error("⚠️ [DB] Failed to initialize ad_creatives table:", e.message);
  }
})();

// In-memory token store: token -> { id, username, role, expires }
const SESSION_SECRET = process.env.ATLAS_SESSION_SECRET || "atlas_secure_session_key_production_2026";
const SESSION_EXPIRATION_DAYS = 30; // Sessions stay valid for 30 days

function generateSessionToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * SESSION_EXPIRATION_DAYS
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${signature}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, signature] = token.split(".");
  const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");

  // Constant-time comparison prevents timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

const app = express();

const allowedOriginPatterns = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /\.vercel\.app$/,
];

if (process.env.FRONTEND_URL) {
  try {
    const parsed = new URL(process.env.FRONTEND_URL).origin;
    allowedOriginPatterns.push(new RegExp(`^${parsed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  } catch {
    allowedOriginPatterns.push(process.env.FRONTEND_URL);
  }
}

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOriginPatterns.some((pattern) =>
      typeof pattern === "string" ? pattern === origin : pattern.test(origin)
    );
    if (isAllowed) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "x-atlas-token",
    "x-atlas-admin-key",
    "ngrok-skip-browser-warning"
  ],
};

app.use(cors(corsOptions));
app.use(express.json());

// Public health check
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Login route (Public)
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const { rows } = await pool.query(
      "SELECT id, username, role FROM users WHERE LOWER(username) = LOWER($1) AND password_hash = $2",
      [username.trim(), hash]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    const token = generateSessionToken(user);

    return res.json({
      status: "authenticated",
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ error: "Authentication service error." });
  }
});

// Session check route
app.get("/api/auth/me", (req, res) => {
  const token = req.get("x-atlas-token") || req.query.token;
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ error: "Session invalid or expired." });
  }
  res.json({ user: { id: session.id, username: session.username, role: session.role } });
});

// Central Role-Based Access Control Middleware
app.use("/api", (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  // Public exceptions
  if (req.path === "/auth/login" || req.path === "/health") {
    return next();
  }

  const token = req.get("x-atlas-token") || req.query.token;
  const session = verifySessionToken(token);

  if (!session) {
    return res.status(401).json({ error: "Unauthorized: Please log in." });
  }

  if (req.method === "GET") {
    req.user = session;
    return next();
  }

  if (session.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden: You do not have permission to modify records or execute scans."
    });
  }

  req.user = session;
  next();
});

let activeScanCancelled = false;
let isScanRunning = false;

function createIdleScanStatus() {
  return {
    scanId: null,
    state: "idle",
    running: false,
    isComplete: false,
    isCancelled: false,
    isError: false,
    fatalError: false,
    target: "",
    targetIndex: 0,
    totalTargets: 0,
    currentAd: 0,
    totalAds: 0,
    timeRemaining: "00:00",
    logs: [],
    packages: [],
    adCounts: {},
    adCountsByCompetitor: {},
    competitorId: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString()
  };
}

let scanStatus = createIdleScanStatus();

function updateScanStatus(patch = {}) {
  const nextLog = typeof patch.log === "string" && patch.log.trim()
    ? patch.log.trim()
    : null;

  const nextLogs = Array.isArray(patch.logs)
    ? patch.logs.filter(Boolean).slice(-5)
    : nextLog
      ? [...(scanStatus.logs || []), nextLog].filter(Boolean).slice(-5)
      : (scanStatus.logs || []);

  scanStatus = {
    ...scanStatus,
    ...patch,
    logs: nextLogs,
    updatedAt: new Date().toISOString()
  };

  return scanStatus;
}

function beginScanStatus(limit) {
  scanStatus = {
    ...createIdleScanStatus(),
    scanId: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    state: "starting",
    running: true,
    target: "Initializing...",
    targetIndex: 1,
    totalTargets: 1,
    currentAd: 0,
    totalAds: Math.max(1, Number(limit) || 1),
    timeRemaining: "Calculating...",
    logs: ["> Booting Intelligence Node..."],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  return scanStatus;
}

app.get("/api/scan-status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(scanStatus);
});

app.post("/api/cancel-scan", (_req, res) => {
  if (!isScanRunning) {
    return res.json({ status: "idle", message: "No scan is currently running." });
  }

  activeScanCancelled = true;
  updateScanStatus({
    state: "cancelling",
    log: "> 🛑 Abort requested. Finishing the current scanner step..."
  });

  res.json({ status: "success", message: "Abort signal sent." });
});

app.get("/api/stats", async (_req, res) => {
  try {
    const competitors = (await pool.query("SELECT COUNT(*) FROM competitors")).rows[0].count;
    const accounts = (await pool.query("SELECT COUNT(*) FROM accounts")).rows[0].count;
    const games = (await pool.query("SELECT COUNT(*) FROM games")).rows[0].count;
    res.json({ competitors: Number(competitors), accounts: Number(accounts), games: Number(games) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/settings", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM settings");
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/settings", async (req, res) => {
  try {
    const updates = req.body;
    for (const [k, v] of Object.entries(updates)) {
      await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, String(v)]);
    }
    res.json({ status: "success", settings: updates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/reset", async (_req, res) => {
  try {
    await pool.query("TRUNCATE account_games, games, accounts, ad_history, competitor_history CASCADE");
    await pool.query("DELETE FROM competitors WHERE ads_id IS NULL OR name = ads_id");
    res.json({ status: "success" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/trending", async (_req, res) => {
  try { 
    const { rows } = await pool.query(`SELECT g.*, a.publisher_name, c.id AS competitor_id, c.name AS competitor_name FROM games g LEFT JOIN account_games ag ON g.id = ag.game_id LEFT JOIN accounts a ON ag.account_id = a.id LEFT JOIN competitors c ON a.competitor_id = c.id ORDER BY g.ad_count DESC`);
    res.json(rows);
  } catch { res.status(500).json({ error: "Fail" }); }
});

app.get("/api/competitor-history", async (_req, res) => {
  try { 
    const { rows } = await pool.query(`SELECT ch.*, c.name FROM competitor_history ch JOIN competitors c ON ch.competitor_id = c.id ORDER BY ch.scan_date ASC`);
    res.json(rows);
  } catch { res.status(500).json({ error: "Fail" }); }
});

// AUTO-RECALIBRATE GRAPH DATA TO MATCH ACTUAL UNIQUE GAMES IN ATLAS
app.post("/api/dev/recalc-history", async (_req, res) => {
  try {
    const { rows: comps } = await pool.query("SELECT id FROM competitors");
    for (const c of comps) {
      const realCountRes = await pool.query(
        `SELECT COUNT(DISTINCT ag.game_id) as count 
         FROM account_games ag 
         JOIN accounts a ON ag.account_id = a.id 
         WHERE a.competitor_id = $1`, 
        [c.id]
      );
      const realGames = parseInt(realCountRes.rows[0]?.count || 0, 10);
      
      await pool.query(
        `INSERT INTO competitor_history (competitor_id, total_ads, scan_date) 
         VALUES ($1, $2, CURRENT_DATE) 
         ON CONFLICT (competitor_id, scan_date) 
         DO UPDATE SET total_ads = $2`, 
        [c.id, realGames]
      );
    }
    res.json({ success: true, message: "History synced with true game counts." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/emails", async (_req, res) => { try { res.json((await pool.query("SELECT * FROM email_lists ORDER BY id DESC")).rows); } catch { res.status(500).json({ error: "Fail" }); } });
app.post("/api/emails", async (req, res) => { try { await pool.query("INSERT INTO email_lists (name, emails) VALUES ($1, $2)", [req.body.name, JSON.stringify(req.body.emails)]); res.json({ status: "success" }); } catch { res.status(500).json({ error: "Fail" }); } });
app.delete("/api/emails/:id", async (req, res) => { try { await pool.query("DELETE FROM email_lists WHERE id = $1", [req.params.id]); res.json({ status: "success" }); } catch { res.status(500).json({ error: "Fail" }); } });

app.get("/api/lists", async (_req, res) => { try { res.json((await pool.query("SELECT * FROM target_lists ORDER BY created_at DESC")).rows.map(list => ({ ...list, targets: JSON.parse(list.targets) }))); } catch { res.status(500).json({ error: "Fail" }); } });
app.post("/api/lists", async (req, res) => { try { const result = await pool.query("INSERT INTO target_lists (name, targets) VALUES ($1, $2) RETURNING id", [req.body.name, JSON.stringify(req.body.targets)]); res.json({ id: result.rows[0].id, name: req.body.name, targets: req.body.targets, is_active: 1 }); } catch { res.status(500).json({ error: "Fail" }); } });
app.patch("/api/lists/:id/toggle", async (req, res) => { try { await pool.query("UPDATE target_lists SET is_active = $1 WHERE id = $2", [req.body.is_active ? 1 : 0, req.params.id]); res.json({ status: "success" }); } catch { res.status(500).json({ error: "Fail" }); } });
app.delete("/api/lists/:id", async (req, res) => { try { await pool.query("DELETE FROM target_lists WHERE id = $1", [req.params.id]); res.json({ status: "success" }); } catch { res.status(500).json({ error: "Fail" }); } });

app.get("/api/saved-competitors", async (_req, res) => { try { res.json((await pool.query("SELECT * FROM competitors WHERE ads_id IS NOT NULL AND name != ads_id ORDER BY id DESC")).rows); } catch { res.status(500).json({ error: "Fail" }); } });

app.delete("/api/saved-competitors/:id", async (req, res) => {
  try {
    const { rows: accounts } = await pool.query("SELECT id FROM accounts WHERE competitor_id = $1", [req.params.id]);
    for (const acc of accounts) { await pool.query("DELETE FROM account_games WHERE account_id = $1", [acc.id]); }
    await pool.query("DELETE FROM accounts WHERE competitor_id = $1", [req.params.id]);
    await pool.query("DELETE FROM competitors WHERE id = $1", [req.params.id]);
    res.json({ status: "success" });
  } catch { res.status(500).json({ error: "Fail" }); }
});

app.delete("/api/competitors/:id/data", async (req, res) => {
  try {
    const compId = req.params.id;
    await pool.query("DELETE FROM competitor_history WHERE competitor_id = $1", [compId]);
    await pool.query("DELETE FROM account_games WHERE account_id IN (SELECT id FROM accounts WHERE competitor_id = $1)", [compId]);
    await pool.query("DELETE FROM accounts WHERE competitor_id = $1", [compId]);
    await pool.query("DELETE FROM competitors WHERE id = $1", [compId]);
    await pool.query("DELETE FROM games WHERE id NOT IN (SELECT game_id FROM account_games)");
    res.json({ status: "success" });
  } catch (err) {
    console.error("Delete Competitor Error:", err);
    res.status(500).json({ error: "Failed to delete competitor data" });
  }
});

app.delete("/api/publishers/:id/data", async (req, res) => {
  try {
    const pubId = req.params.id;
    await pool.query("DELETE FROM account_games WHERE account_id = $1", [pubId]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [pubId]);
    await pool.query("DELETE FROM games WHERE id NOT IN (SELECT game_id FROM account_games)");
    res.json({ status: "success" });
  } catch (err) {
    console.error("Delete Publisher Error:", err);
    res.status(500).json({ error: "Failed to delete publisher data" });
  }
});

app.delete("/api/games/:id/data", async (req, res) => {
  if (isScanRunning) {
    return res.status(409).json({
      error: "Wait for the active scan to finish before deleting a game."
    });
  }

  const gameId = Number(req.params.id);
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: "Invalid game ID." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id, package_name, title FROM games WHERE id = $1 FOR UPDATE",
      [gameId]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Game not found." });
    }

    const game = rows[0];

    // Remove every Atlas relationship/history row for this game before
    // deleting the game itself. Publisher and competitor entities are kept.
    await client.query("DELETE FROM account_games WHERE game_id = $1", [gameId]);
    await client.query("DELETE FROM ad_history WHERE game_id = $1", [gameId]);
    await client.query("DELETE FROM games WHERE id = $1", [gameId]);

    await client.query("COMMIT");

    // Keep the recoverable latest-scan status consistent with the database so
    // refreshing Atlas cannot resurrect a deleted game in the Latest Scan UI.
    const packageName = game.package_name;
    if (packageName) {
      const nextAdCounts = { ...(scanStatus.adCounts || {}) };
      delete nextAdCounts[packageName];

      const nextAdCountsByCompetitor = {};
      for (const [competitorId, counts] of Object.entries(scanStatus.adCountsByCompetitor || {})) {
        const nextCounts = { ...(counts || {}) };
        delete nextCounts[packageName];
        if (Object.keys(nextCounts).length > 0) {
          nextAdCountsByCompetitor[competitorId] = nextCounts;
        }
      }

      updateScanStatus({
        packages: Array.isArray(scanStatus.packages)
          ? scanStatus.packages.filter(pkg => pkg !== packageName)
          : [],
        adCounts: nextAdCounts,
        adCountsByCompetitor: nextAdCountsByCompetitor
      });
    }

    res.json({
      status: "success",
      id: game.id,
      package_name: game.package_name,
      title: game.title
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Delete Game Error:", err);
    res.status(500).json({ error: "Failed to delete game data" });
  } finally {
    client.release();
  }
});

app.post("/api/scan", async (req, res) => {
  const { searchQuery, scanType, targetId, targetCountry, limit, sendReport, emailListId, reportEmail } = req.body;
  const customReportEmail = typeof reportEmail === "string" ? reportEmail.trim() : "";

  if (sendReport === true && customReportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customReportEmail)) {
    return res.status(400).json({ error: "Invalid report email address." });
  }
  
  if (isScanRunning) {
    return res.status(409).json({ error: "A scan is already active. Please wait." });
  }

  activeScanCancelled = false;
  isScanRunning = true;
  beginScanStatus(limit);

  res.json({
    status: "initiated",
    message: "Scan running in background.",
    scanId: scanStatus.scanId
  });

  (async () => {
    try {
      let targets = []; 
      if (scanType === "list") {
        const list = (await pool.query("SELECT targets FROM target_lists WHERE id = $1", [targetId])).rows[0];
        if (list) targets = JSON.parse(list.targets).map(t => ({ query: t, name: t, adsId: t.startsWith('AR') ? t : null }));
      } else if (scanType === "competitor") {
        const comp = (await pool.query("SELECT name, ads_id FROM competitors WHERE id = $1", [targetId])).rows[0];
        if (comp) targets = [{ query: comp.ads_id || comp.name, name: comp.name, adsId: comp.ads_id }];
      } else {
        targets = [{ query: searchQuery, name: searchQuery, adsId: searchQuery.startsWith('AR') ? searchQuery : null }];
      }

      if (targets.length === 0) {
        isScanRunning = false;
        updateScanStatus({
          state: "error",
          running: false,
          isError: true,
          fatalError: true,
          finishedAt: new Date().toISOString(),
          timeRemaining: "00:00",
          log: "> ❌ No scan targets specified."
        });
        return;
      }

      updateScanStatus({
        state: "running",
        totalTargets: targets.length,
        targetIndex: 1
      });

      const fixUrl = (url) => url && url.startsWith('//') ? 'https:' + url : url;
      let allResults = [];
      let isolatedScanData = []; 
      const interceptedPackageSet = new Set();
      let lastResolvedCompetitorId = null;

      for (let tIndex = 0; tIndex < targets.length; tIndex++) {
        if (activeScanCancelled) break;
        
        const targetQuery = targets[tIndex].query;
        let targetAdsId = targets[tIndex].adsId;
        let targetDisplayName = targets[tIndex].name;

        let compQuery = null;
        if (targetAdsId) {
          compQuery = (await pool.query(`SELECT id, name, ads_id FROM competitors WHERE ads_id = $1 ORDER BY CASE WHEN name != ads_id THEN 0 ELSE 1 END, id DESC LIMIT 1`, [targetAdsId])).rows[0];
        } else {
          compQuery = (await pool.query("SELECT id, name, ads_id FROM competitors WHERE name = $1 ORDER BY id DESC LIMIT 1", [targetDisplayName])).rows[0];
        }

        if (compQuery && compQuery.name !== targetAdsId && compQuery.name !== compQuery.ads_id) { 
          targetDisplayName = compQuery.name; 
        } else if (targetAdsId) { 
          targetDisplayName = `Unsaved (${targetAdsId})`; 
        }

        let competitorId;
        if (!compQuery) {
          const resComp = await pool.query("INSERT INTO competitors (name, ads_id, country) VALUES ($1, $2, $3) RETURNING id", [targetDisplayName, targetAdsId, targetCountry]);
          competitorId = resComp.rows[0].id;
        } else {
          competitorId = compQuery.id;
          if (compQuery.name === targetAdsId && targetDisplayName !== targetAdsId) { 
            await pool.query("UPDATE competitors SET name = $1 WHERE id = $2", [targetDisplayName, competitorId]); 
          }
        }

        lastResolvedCompetitorId = competitorId;

        updateScanStatus({
          state: "running",
          running: true,
          target: targetDisplayName,
          targetIndex: tIndex + 1,
          totalTargets: targets.length,
          currentAd: 0,
          totalAds: Math.max(1, Number(limit) || 1),
          timeRemaining: "Calculating...",
          log: `> 🎯 Starting target ${tIndex + 1}/${targets.length}: ${targetDisplayName}`
        });

        const results = await scanCompetitor(
          targetQuery, 
          targetCountry, 
          limit, 
          (progressData) => {
            updateScanStatus({
              ...progressData,
              running: true,
              target: targetDisplayName,
              targetIndex: tIndex + 1,
              totalTargets: targets.length
            });
          }, 
          async () => {},
          () => activeScanCancelled
        );

        if (activeScanCancelled) break;

        // Early exit: Target produced 0 Play Store packages/ads
        if (!results || results.length === 0) {
          console.log(`⚠️ [SCAN] No valid Play Store packages found for target: "${targetDisplayName}". Skipping downstream sync.`);
          updateScanStatus({
            target: targetDisplayName,
            targetIndex: tIndex + 1,
            totalTargets: targets.length,
            currentAd: 0,
            totalAds: 0,
            timeRemaining: "00:00",
            log: `> ⚠️ No active mobile game campaigns found for "${targetDisplayName}".`
          });
          continue;
        }

        // Group this scan's findings by package, keeping the exact set of
        // creative (ad) IDs seen for each one. GoogleAdsScanner only contributes
        // a package once per creative, so each set is bounded by the number of
        // creatives scanned for this competitor.
        const creativeIdsByPackage = {};
        for (const entry of results) {
          const pkg = entry.package;
          interceptedPackageSet.add(pkg);
          if (!creativeIdsByPackage[pkg]) creativeIdsByPackage[pkg] = new Set();
          creativeIdsByPackage[pkg].add(entry.creativeId);
        }

        // currentScanAdCounts mirrors the old package -> count shape so the
        // status/report code just below doesn't need to change.
        const currentScanAdCounts = {};
        for (const [pkg, idsSet] of Object.entries(creativeIdsByPackage)) {
          currentScanAdCounts[pkg] = idsSet.size;
        }

        // Keep exact latest-scan counts separate from the historical lifetime
        // counter stored in games.ad_count. For batch scans, adCounts stores the
        // highest per-competitor count for each package (never a sum across
        // competitors), while adCountsByCompetitor preserves the exact target.
        const mergedAdCounts = { ...(scanStatus.adCounts || {}) };
        for (const [pkg, count] of Object.entries(currentScanAdCounts)) {
          mergedAdCounts[pkg] = Math.max(Number(mergedAdCounts[pkg]) || 0, Number(count) || 0);
        }

        const mergedAdCountsByCompetitor = {
          ...(scanStatus.adCountsByCompetitor || {}),
          [String(competitorId)]: { ...currentScanAdCounts }
        };

        const completedAdsForTarget = Math.max(
          0,
          Number(scanStatus.totalAds) || Number(limit) || 0
        );

        updateScanStatus({
          target: targetDisplayName,
          targetIndex: tIndex + 1,
          totalTargets: targets.length,
          currentAd: completedAdsForTarget,
          totalAds: completedAdsForTarget,
          timeRemaining: "00:00",
          adCounts: mergedAdCounts,
          adCountsByCompetitor: mergedAdCountsByCompetitor,
          log: `> 🗄️ Ingesting creative entities to Atlas database...`
        });

        // Enrich and persist each UNIQUE package once. The full per-scan count is
        // applied in one database operation, avoiding the previous off-by-one bug.
        for (const [pkg, creativeIdsSet] of Object.entries(creativeIdsByPackage)) {
          const creativeIds = [...creativeIdsSet];
          const scanAdCount = Math.max(1, creativeIds.length);

          // Only creative IDs Atlas has never logged before should count toward
          // the lifetime ad_count / daily history. Re-seeing the same
          // still-running ad on a later scan no longer inflates the total.
          let newAdCount = scanAdCount;
          try {
            const { rows: alreadySeen } = await pool.query(
              "SELECT creative_id FROM ad_creatives WHERE creative_id = ANY($1)",
              [creativeIds]
            );
            const alreadySeenSet = new Set(alreadySeen.map(r => r.creative_id));
            newAdCount = creativeIds.filter(id => !alreadySeenSet.has(id)).length;
          } catch (e) {
            console.error("ad_creatives lookup failed, counting all as new:", e.message);
          }

          let appData = null;
          try {
            appData = await gplay.app({ appId: pkg, country: 'us' });
          } catch {
            try {
              appData = await gplay.app({ appId: pkg });
            } catch {
              const cleanTitle = pkg.split('.').slice(-2).join(' ').replace(/_/g, ' ').toUpperCase();
              appData = {
                title: cleanTitle,
                developer: targetDisplayName || "Unknown Developer",
                genre: "Game",
                score: 0,
                ratings: 0,
                icon: null,
                screenshots: [],
                description: "Captured directly via ad stream",
                installs: "0+",
                minInstalls: 0,
                released: "Unknown",
                updated: Date.now()
              };
            }
          }

          const pubName = appData.developer || targetDisplayName || "Unknown Publisher";
          const normalizedPub = pubName.toLowerCase().replace(/[^a-z0-9]/g, "");

          // Match on the already-normalized name, not the raw developer string.
          // The Play Store can return slightly different casing/punctuation for
          // the same publisher across scans, which used to create a second
          // "accounts" row and make the same game appear twice in the tree.
          let accQuery = (await pool.query(
            "SELECT id FROM accounts WHERE normalized_name = $1 AND competitor_id = $2",
            [normalizedPub, competitorId]
          )).rows[0];

          let accountId;
          if (!accQuery) {
            const accRes = await pool.query(
              "INSERT INTO accounts (competitor_id, publisher_name, normalized_name) VALUES ($1, $2, $3) RETURNING id",
              [competitorId, pubName, normalizedPub]
            );
            accountId = accRes.rows[0].id;
          } else {
            accountId = accQuery.id;
          }

          let similarApps = [];
          try {
            const rawSimilar = await gplay.similar({ appId: pkg, country: 'us' });
            similarApps = (rawSimilar || [])
              .filter(sim => sim.developer !== pubName)
              .slice(0, 6)
              .map(sim => ({
                title: sim.title,
                appId: sim.appId,
                developer: sim.developer,
                icon: fixUrl(sim.icon),
                score: sim.score || 0
              }));
          } catch {}

          // games.ad_count is intentionally the ALL-TIME detection counter.
          // Increment it by the exact count from this target scan in one shot.
          const insertGame = `
            INSERT INTO games (
              package_name, title, category, rating, ratings_count, icon,
              screenshots, description, installs, min_installs, released,
              updated, similar_apps, ad_count, header_image, video, video_image
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, $17
            )
            ON CONFLICT (package_name) DO UPDATE SET
              title = EXCLUDED.title,
              category = EXCLUDED.category,
              rating = EXCLUDED.rating,
              ratings_count = EXCLUDED.ratings_count,
              icon = EXCLUDED.icon,
              screenshots = EXCLUDED.screenshots,
              description = EXCLUDED.description,
              installs = EXCLUDED.installs,
              min_installs = EXCLUDED.min_installs,
              released = EXCLUDED.released,
              updated = EXCLUDED.updated,
              similar_apps = EXCLUDED.similar_apps,
              ad_count = games.ad_count + EXCLUDED.ad_count,
              header_image = EXCLUDED.header_image,
              video = EXCLUDED.video,
              video_image = EXCLUDED.video_image
            RETURNING id
          `;

          const gameRes = await pool.query(insertGame, [
            pkg,
            appData.title,
            appData.genre,
            appData.score || 0,
            appData.ratings || 0,
            fixUrl(appData.icon),
            JSON.stringify((appData.screenshots || []).map(fixUrl)),
            appData.description,
            appData.installs || "0+",
            appData.minInstalls || 0,
            appData.released || "Unknown",
            appData.updated || 0,
            JSON.stringify(similarApps),
            newAdCount,
            fixUrl(appData.headerImage) || null,
            appData.video || null,
            fixUrl(appData.videoImage) || null
          ]);

          const gameId = gameRes.rows[0].id;

          await pool.query(
            "INSERT INTO account_games (account_id, game_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [accountId, gameId]
          );

          // Record/refresh every creative ID seen for this package so a later
          // scan can tell "still running" apart from "genuinely new".
          for (const creativeId of creativeIds) {
            try {
              await pool.query(
                `INSERT INTO ad_creatives (creative_id, game_id, competitor_id, package_name, first_seen_at, last_seen_at)
                 VALUES ($1, $2, $3, $4, now(), now())
                 ON CONFLICT (creative_id) DO UPDATE SET
                   last_seen_at = now(),
                   game_id = EXCLUDED.game_id,
                   competitor_id = EXCLUDED.competitor_id,
                   package_name = EXCLUDED.package_name`,
                [creativeId, gameId, competitorId, pkg]
              );
            } catch (e) {
              console.error("Failed to record ad_creatives row:", creativeId, e.message);
            }
          }

          // Daily history remains cumulative across multiple scans on the same
          // day, but only genuinely new ad detections add to the total now.
          await pool.query(
            `INSERT INTO ad_history (game_id, ad_count, scan_date)
             VALUES ($1, $2, CURRENT_DATE)
             ON CONFLICT (game_id, scan_date)
             DO UPDATE SET ad_count = ad_history.ad_count + EXCLUDED.ad_count`,
            [gameId, newAdCount]
          );

          // The report must use THIS scan's count, not the lifetime counter.
          isolatedScanData.push({
            title: appData.title,
            publisher_name: pubName,
            package_name: pkg,
            icon: fixUrl(appData.icon),
            category: appData.genre || "Game",
            rating: appData.score || 0,
            ratings_count: appData.ratings || 0,
            installs: appData.installs || "0+",
            min_installs: appData.minInstalls || 0,
            released: appData.released || "Unknown",
            updated: appData.updated || 0,
            scan_ads: scanAdCount,
            target_name: targetDisplayName,
            competitor_id: competitorId
          });
        }

        const compGamesCountRes = await pool.query(
          `SELECT COUNT(DISTINCT ag.game_id) as count 
           FROM account_games ag 
           JOIN accounts a ON ag.account_id = a.id 
           WHERE a.competitor_id = $1`,
          [competitorId]
        );
        const totalGamesForCompetitor = parseInt(compGamesCountRes.rows[0]?.count || 0, 10);

        await pool.query(
          `INSERT INTO competitor_history (competitor_id, total_ads, scan_date) 
           VALUES ($1, $2, CURRENT_DATE) 
           ON CONFLICT (competitor_id, scan_date) 
           DO UPDATE SET total_ads = EXCLUDED.total_ads`, 
          [competitorId, totalGamesForCompetitor]
        );

        try { 
          // pushScanToSheets expects plain package_name strings.
          await pushScanToSheets(pool, targetDisplayName, Object.keys(creativeIdsByPackage)); 
          await syncPublisherLinksToSheets(pool, targetDisplayName, targetAdsId);
        } catch (err) { console.error("Sheets Sync Error:", err); }
        
        allResults.push(...results);
      } 

      if (activeScanCancelled) {
        isScanRunning = false;
        updateScanStatus({
          state: "cancelled",
          running: false,
          isCancelled: true,
          timeRemaining: "00:00",
          finishedAt: new Date().toISOString(),
          log: `> 🛑 Process cleanly terminated by user.`
        });
        return;
      }

      if (sendReport === true && isolatedScanData.length > 0) {
        try {
          let recipients = "";

          if (customReportEmail) {
            recipients = customReportEmail;
          } else if (emailListId && emailListId !== "none") {
            const emailRow = (await pool.query("SELECT emails FROM email_lists WHERE id = $1", [emailListId])).rows[0];
            if (emailRow) {
              const savedEmails = JSON.parse(emailRow.emails);
              if (Array.isArray(savedEmails)) recipients = savedEmails.join(", ");
            }
          }

          if (recipients) {
            await generateAndSendReport(recipients, isolatedScanData);
          }
        } catch (err) {
          console.error("Report send error:", err);
        }
      }

      isScanRunning = false;

      const totalPackages = interceptedPackageSet.size;

      updateScanStatus({
        state: "complete",
        running: false,
        isComplete: true,
        isCancelled: false,
        isError: false,
        fatalError: false,
        target: "Batch Completed",
        timeRemaining: "00:00",
        packages: Array.from(interceptedPackageSet),
        competitorId: lastResolvedCompetitorId,
        finishedAt: new Date().toISOString(),
        log: totalPackages > 0
          ? `> 🎉 Ingest complete. Synchronized ${allResults.length} records.`
          : `> ℹ️ Scan finished. No mobile game ad campaigns found for this target.`
      });

    } catch (error) {
      console.error("Scan Execution Error:", error);
      isScanRunning = false;
      updateScanStatus({
        state: "error",
        running: false,
        isError: true,
        fatalError: true,
        timeRemaining: "00:00",
        finishedAt: new Date().toISOString(),
        log: `> ❌ Scan failed: ${error.message}`
      });
    }
  })();
});

app.post("/api/competitors", async (req, res) => {
  const result = await pool.query("INSERT INTO competitors (name, ads_id, country) VALUES ($1, $2, $3) RETURNING id", [req.body.name, req.body.adsId || null, req.body.country || null]);
  res.json({ id: result.rows[0].id, name: req.body.name, adsId: req.body.adsId || null });
});

app.post("/api/accounts", async (req, res) => {
  const result = await pool.query("INSERT INTO accounts (competitor_id, publisher_name, normalized_name) VALUES ($1, $2, $3) RETURNING id", [req.body.competitorId || null, req.body.publisherName, req.body.publisherName.toLowerCase().replace(/[^a-z0-9]/g, "")]);
  res.json({ id: result.rows[0].id });
});

app.post("/api/games", (_req, res) => { res.json({ status: "ok" }); });

// Concurrent directory fetch route
app.get("/api/competitors", async (_req, res) => {
  try {
    const [compRes, accRes, gamesRes] = await Promise.all([
      pool.query("SELECT * FROM competitors ORDER BY id DESC"),
      pool.query("SELECT * FROM accounts"),
      pool.query(`
        SELECT ag.account_id, g.* 
        FROM account_games ag 
        JOIN games g ON ag.game_id = g.id
      `)
    ]);

    const competitors = compRes.rows;
    const accounts = accRes.rows;
    const gameLinks = gamesRes.rows;

    const gamesByAccount = {};
    for (const game of gameLinks) {
      if (!gamesByAccount[game.account_id]) gamesByAccount[game.account_id] = [];
      gamesByAccount[game.account_id].push(game);
    }

    const accountsByCompetitor = {};
    for (const acc of accounts) {
      if (!accountsByCompetitor[acc.competitor_id]) accountsByCompetitor[acc.competitor_id] = [];
      accountsByCompetitor[acc.competitor_id].push({
        ...acc,
        games: gamesByAccount[acc.id] || []
      });
    }

    const tree = competitors.map(comp => ({
      ...comp,
      accounts: accountsByCompetitor[comp.id] || []
    }));

    res.json(tree);
  } catch (err) { 
    console.error("Tree Fetch Error:", err);
    res.status(500).json({ error: "Fail" }); 
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Atlas backend running on http://localhost:${PORT}`));