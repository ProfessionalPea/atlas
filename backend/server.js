require("dotenv").config();
const { generateAndSendReport } = require("./AutomatedReport");
const { scanCompetitor } = require("./GoogleAdsScanner");
const { pushScanToSheets, syncPublisherLinksToSheets } = require("./GoogleSheetsSync"); 
const EventEmitter = require('events');
const cron = require('node-cron');
const express = require("express");
const cors = require("cors");
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const gplayRaw = require('google-play-scraper');
const scanEvents = new EventEmitter();
const gplay = gplayRaw.default || gplayRaw;

const app = express();
app.use(cors());
app.use(express.json());

let activeScanCancelled = false;
let isScanRunning = false;

app.post("/api/cancel-scan", (_req, res) => {
  activeScanCancelled = true;
  res.json({ status: "success", message: "Abort signal sent." });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

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
    const { rows } = await pool.query(`SELECT g.*, a.publisher_name, c.name AS competitor_name FROM games g LEFT JOIN account_games ag ON g.id = ag.game_id LEFT JOIN accounts a ON ag.account_id = a.id LEFT JOIN competitors c ON a.competitor_id = c.id ORDER BY g.ad_count DESC`);
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

app.post("/api/dev/seed-history", async (_req, res) => {
  try {
    const { rows: competitors } = await pool.query("SELECT id FROM competitors");
    for (const c of competitors) {
      const gameCountRes = await pool.query(
        `SELECT COUNT(DISTINCT ag.game_id) as count 
         FROM account_games ag 
         JOIN accounts a ON ag.account_id = a.id 
         WHERE a.competitor_id = $1`, [c.id]
      );
      let currentGames = parseInt(gameCountRes.rows[0]?.count || 0, 10);
      if (currentGames === 0) currentGames = Math.floor(Math.random() * 8) + 6;

      for (let i = 0; i < 7; i++) {
        let dayGames = Math.max(1, currentGames - Math.floor((6 - i) * 1.2));
        await pool.query(
          `INSERT INTO competitor_history (competitor_id, total_ads, scan_date) 
           VALUES ($1, $2, CURRENT_DATE - ($3 || ' days')::interval) 
           ON CONFLICT (competitor_id, scan_date) 
           DO UPDATE SET total_ads = EXCLUDED.total_ads`, 
          [c.id, dayGames, 6 - i]
        );
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

app.get("/api/scan-stream", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive" });
  res.write(`data: ${JSON.stringify({ log: "> Secure SSE connection established..." })}\n\n`);
  const sendProgress = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
  scanEvents.on("progress", sendProgress);
  _req.on("close", () => { scanEvents.off("progress", sendProgress); });
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

  // Immediate response prevents 60s Ngrok gateway timeout
  res.json({ status: "initiated", message: "Scan running in background." });

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
        return scanEvents.emit("progress", { isError: true, log: "> ❌ No scan targets specified." });
      }

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

        const results = await scanCompetitor(
          targetQuery, 
          targetCountry, 
          limit, 
          (progressData) => {
            scanEvents.emit("progress", { ...progressData, target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length });
          }, 
          async () => {}, // Safe callback handler
          () => activeScanCancelled
        );

        if (activeScanCancelled) break;

        const currentScanAdCounts = {};
        scanEvents.emit("progress", { target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length, currentAd: limit, totalAds: limit, timeRemaining: "00:00", log: `> 🗄️ Ingesting creative entities to Atlas database...` });

        for (const pkg of results) {
          interceptedPackageSet.add(pkg);
          currentScanAdCounts[pkg] = (currentScanAdCounts[pkg] || 0) + 1;

          if (currentScanAdCounts[pkg] === 1) {
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

            let accQuery = (await pool.query("SELECT id FROM accounts WHERE publisher_name = $1 AND competitor_id = $2", [pubName, competitorId])).rows[0];
            let accountId;
            if (!accQuery) { 
              const accRes = await pool.query("INSERT INTO accounts (competitor_id, publisher_name, normalized_name) VALUES ($1, $2, $3) RETURNING id", [competitorId, pubName, normalizedPub]);
              accountId = accRes.rows[0].id;
            } else { accountId = accQuery.id; }

            let similarApps = [];
            try {
              const rawSimilar = await gplay.similar({ appId: pkg, country: 'us' });
              similarApps = (rawSimilar || []).filter(sim => sim.developer !== pubName).slice(0, 6).map(sim => ({ title: sim.title, appId: sim.appId, developer: sim.developer, icon: fixUrl(sim.icon), score: sim.score || 0 }));
            } catch {}

            const insertGame = `INSERT INTO games (package_name, title, category, rating, ratings_count, icon, screenshots, description, installs, min_installs, released, updated, similar_apps, ad_count, header_image, video, video_image) 
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
                                ON CONFLICT (package_name) DO UPDATE SET 
                                title=EXCLUDED.title, category=EXCLUDED.category, rating=EXCLUDED.rating, ratings_count=EXCLUDED.ratings_count, icon=EXCLUDED.icon, screenshots=EXCLUDED.screenshots, description=EXCLUDED.description, installs=EXCLUDED.installs, min_installs=EXCLUDED.min_installs, released=EXCLUDED.released, updated=EXCLUDED.updated, similar_apps=EXCLUDED.similar_apps, header_image=EXCLUDED.header_image, video=EXCLUDED.video, video_image=EXCLUDED.video_image
                                RETURNING id`;
            
            const gameRes = await pool.query(insertGame, [pkg, appData.title, appData.genre, appData.score || 0, appData.ratings || 0, fixUrl(appData.icon), JSON.stringify((appData.screenshots || []).map(fixUrl)), appData.description, appData.installs || "0+", appData.minInstalls || 0, appData.released || "Unknown", appData.updated || 0, JSON.stringify(similarApps), 1, fixUrl(appData.headerImage) || null, appData.video || null, fixUrl(appData.videoImage) || null]);
            const gameId = gameRes.rows[0].id;

            await pool.query("INSERT INTO account_games (account_id, game_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [accountId, gameId]);
            await pool.query(`INSERT INTO ad_history (game_id, ad_count, scan_date) VALUES ($1, 1, CURRENT_DATE) ON CONFLICT (game_id, scan_date) DO UPDATE SET ad_count = ad_history.ad_count + 1`, [gameId]);
            
            isolatedScanData.push({ title: appData.title, publisher_name: pubName, category: appData.genre, rating: appData.score || 0, installs: appData.installs || "0+" });
          } else {
            try {
              await pool.query("UPDATE games SET ad_count = ad_count + 1 WHERE package_name = $1", [pkg]);
              await pool.query(`UPDATE ad_history SET ad_count = ad_count + 1 WHERE game_id = (SELECT id FROM games WHERE package_name = $1) AND scan_date = CURRENT_DATE`, [pkg]);
            } catch {}
          }
        }

        // QUERY EXACT UNIQUE GAMES COUNT FOR THIS COMPETITOR
        const compGamesCountRes = await pool.query(
          `SELECT COUNT(DISTINCT ag.game_id) as count 
           FROM account_games ag 
           JOIN accounts a ON ag.account_id = a.id 
           WHERE a.competitor_id = $1`,
          [competitorId]
        );
        const totalGamesForCompetitor = parseInt(compGamesCountRes.rows[0]?.count || 0, 10);

        // Record real game count, NOT ad volume
        await pool.query(
          `INSERT INTO competitor_history (competitor_id, total_ads, scan_date) 
           VALUES ($1, $2, CURRENT_DATE) 
           ON CONFLICT (competitor_id, scan_date) 
           DO UPDATE SET total_ads = EXCLUDED.total_ads`, 
          [competitorId, totalGamesForCompetitor]
        );

        try { 
          await pushScanToSheets(pool, targetDisplayName, results); 
          await syncPublisherLinksToSheets(pool, targetDisplayName, targetAdsId);
        } catch (err) { console.error("Sheets Sync Error:", err); }
        
        allResults.push(...results);
      } 

      if (activeScanCancelled) {
        isScanRunning = false;
        return scanEvents.emit("progress", { 
          isCancelled: true, 
          log: `> 🛑 Process cleanly terminated by user.` 
        });
      }

      if (sendReport === true && isolatedScanData.length > 0) {
        try {
          let recipients = "";

          // One-time custom recipient from the dashboard takes priority.
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

      // Signals UI to finish and update view
      scanEvents.emit("progress", { 
        isComplete: true, 
        target: "Batch Completed",
        packages: Array.from(interceptedPackageSet),
        competitorId: lastResolvedCompetitorId,
        log: `> 🎉 Ingest complete. Synchronized ${allResults.length} records.`
      });

    } catch (error) {
      console.error("Scan Execution Error:", error);
      isScanRunning = false;
      scanEvents.emit("progress", { isError: true, log: `> ❌ Scan failed: ${error.message}` });
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

// BLAZING FAST CONCURRENT FETCH ROUTE
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

cron.schedule('0 3 * * *', async () => {
  const isEnabled = (await pool.query("SELECT value FROM settings WHERE key = 'ghost_scan_enabled'")).rows[0]?.value;
  if (isEnabled !== "1") return;
  try {
    const targets = (await pool.query("SELECT name, country FROM competitors")).rows;
    for (const target of targets) {
      await scanCompetitor(target.name, target.country || "Any", 500, () => {}, async () => {}, () => false);
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  } catch (error) { console.error("Ghost automation error:", error); }
});

cron.schedule('0 6 * * *', async () => {
  const isEnabled = (await pool.query("SELECT value FROM settings WHERE key = 'auto_report_enabled'")).rows[0]?.value;
  if (isEnabled !== "1") return;
  const defaultEmail = (await pool.query("SELECT value FROM settings WHERE key = 'default_report_email'")).rows[0]?.value || "danish1042awan@gmail.com";
  await generateAndSendReport(defaultEmail);
});

app.listen(PORT, () => console.log(`Atlas backend running on http://localhost:${PORT}`));