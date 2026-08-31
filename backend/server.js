const { generateAndSendReport } = require("./AutomatedReport");
const { scanCompetitor } = require("./GoogleAdsScanner");
const { pushScanToSheets } = require("./GoogleSheetsSync"); 
const EventEmitter = require('events');
const cron = require('node-cron');
const express = require("express");
const cors = require("cors");
const fs = require("fs"); 
const db = require("./database");

// Safe Schema Upgrader: Evaluates every column independently
const addColumn = (table, column, type) => {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run(); } catch (e) {}
};

// Auto-upgrade DB
addColumn("games", "similar_apps", "TEXT");
addColumn("games", "installs", "TEXT");
addColumn("games", "min_installs", "INTEGER");
addColumn("games", "released", "TEXT");
addColumn("games", "updated", "INTEGER");
addColumn("games", "ad_count", "INTEGER DEFAULT 1");
addColumn("games", "icon", "TEXT");
addColumn("games", "screenshots", "TEXT");
addColumn("games", "description", "TEXT");

// Auto-upgrade DB for Target Lists
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS target_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      targets TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
} catch (e) {
  console.error("DB Upgrade Error:", e);
}

const gplayRaw = require('google-play-scraper');
const scanEvents = new EventEmitter();
const gplay = gplayRaw.default || gplayRaw;

const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// DASHBOARD & SCAN ROUTES
// ----------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Atlas backend is running" });
});

app.get("/api/stats", (req, res) => {
  const competitors = db.prepare("SELECT COUNT(*) AS count FROM competitors").get().count;
  const accounts = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
  const games = db.prepare("SELECT COUNT(*) AS count FROM games").get().count;

  res.json({ competitors, accounts, games });
});

// --- NON-DESTRUCTIVE DATABASE RESET ---
app.post("/api/reset", (req, res) => {
  try {
    console.log("🧹 NUKE INITIATED: Wiping scan data cache...");
    
    db.prepare("DELETE FROM account_games").run();
    db.prepare("DELETE FROM games").run();
    db.prepare("DELETE FROM accounts").run();
    db.prepare("DELETE FROM competitors WHERE ads_id IS NULL").run();
    
    console.log("✨ Scan cache wiped. Saved competitors, batch lists, and email lists preserved.");
    res.json({ status: "success" });
  } catch (err) {
    console.error("Reset Error:", err);
    res.status(500).json({ error: "Failed to reset scan data" });
  }
});

// --- TOP CHARTS ROUTE ---
app.get("/api/trending", (req, res) => {
  try {
    const trending = db.prepare(`
      SELECT g.id, g.title, g.icon, g.package_name, g.installs, g.min_installs, g.category, g.released, g.updated, g.similar_apps, g.rating, g.ratings_count, g.screenshots, g.ad_count, a.publisher_name 
      FROM games g
      LEFT JOIN account_games ag ON g.id = ag.game_id
      LEFT JOIN accounts a ON ag.account_id = a.id
      ORDER BY g.ad_count DESC
    `).all();
    res.json(trending);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trending" });
  }
});

// ==========================================
// ✉️ EMAIL LIST MANAGEMENT
// ==========================================

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS email_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emails TEXT NOT NULL
  )`).run();
} catch (e) { }

app.get("/api/emails", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM email_lists ORDER BY id DESC").all()); } 
  catch (err) { res.status(500).json({ error: "Failed to fetch emails" }); }
});

app.post("/api/emails", (req, res) => {
  const { name, emails } = req.body;
  try { db.prepare("INSERT INTO email_lists (name, emails) VALUES (?, ?)").run(name, JSON.stringify(emails)); res.json({ status: "success" }); } 
  catch (err) { res.status(500).json({ error: "Failed to save email" }); }
});

app.delete("/api/emails/:id", (req, res) => {
  try { db.prepare("DELETE FROM email_lists WHERE id = ?").run(req.params.id); res.json({ status: "success" }); } 
  catch (err) { res.status(500).json({ error: "Failed to delete" }); }
});

// ----------------------------------------------------
// TARGET LISTS ROUTES (AUTOMATED SCANS)
// ----------------------------------------------------

app.get("/api/lists", (req, res) => {
  try {
    const lists = db.prepare("SELECT * FROM target_lists ORDER BY created_at DESC").all();
    const parsedLists = lists.map(list => ({ ...list, targets: JSON.parse(list.targets) }));
    res.json(parsedLists);
  } catch (err) { res.status(500).json({ error: "Failed to fetch lists" }); }
});

app.post("/api/lists", (req, res) => {
  const { name, targets } = req.body;
  if (!name || !targets || !Array.isArray(targets)) return res.status(400).json({ error: "Invalid data" });
  try {
    const result = db.prepare("INSERT INTO target_lists (name, targets) VALUES (?, ?)").run(name, JSON.stringify(targets));
    res.json({ id: result.lastInsertRowid, name, targets, is_active: 1 });
  } catch (err) { res.status(500).json({ error: "Failed to create list" }); }
});

app.patch("/api/lists/:id/toggle", (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try { db.prepare("UPDATE target_lists SET is_active = ? WHERE id = ?").run(is_active ? 1 : 0, id); res.json({ status: "success" }); } 
  catch (err) { res.status(500).json({ error: "Failed to toggle list" }); }
});

app.delete("/api/lists/:id", (req, res) => {
  const { id } = req.params;
  try { db.prepare("DELETE FROM target_lists WHERE id = ?").run(id); res.json({ status: "success" }); } 
  catch (err) { res.status(500).json({ error: "Failed to delete list" }); }
});

// --- SAVED COMPETITORS MANAGEMENT ---

try { db.prepare("ALTER TABLE competitors ADD COLUMN ads_id TEXT").run(); } catch (e) { }

app.get("/api/saved-competitors", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM competitors WHERE ads_id IS NOT NULL ORDER BY id DESC").all()); } 
  catch(err) { res.status(500).json({error: "Failed to fetch saved competitors"}); }
});

app.delete("/api/saved-competitors/:id", (req, res) => {
  const { id } = req.params;
  try {
    const accounts = db.prepare("SELECT id FROM accounts WHERE competitor_id = ?").all(id);
    accounts.forEach(acc => { db.prepare("DELETE FROM account_games WHERE account_id = ?").run(acc.id); });
    db.prepare("DELETE FROM accounts WHERE competitor_id = ?").run(id);
    db.prepare("DELETE FROM competitors WHERE id = ?").run(id);
    res.json({ status: "success" });
  } catch (err) { res.status(500).json({ error: "Failed to delete competitor" }); }
});

app.get("/api/scan-stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  
  res.write(`data: ${JSON.stringify({ log: "> Secure SSE connection established..." })}\n\n`);
  const sendProgress = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
  scanEvents.on("progress", sendProgress);
  req.on("close", () => { scanEvents.off("progress", sendProgress); });
});

// --- THE ULTIMATE BATCH SCAN ROUTE ---
app.post("/api/scan", async (req, res) => {
  const { searchQuery, scanType, targetId, targetCountry, limit, sendReport, emailListId } = req.body;
  
  try {
    let targets = []; 
    
    if (scanType === "list") {
      const list = db.prepare("SELECT targets FROM target_lists WHERE id = ?").get(targetId);
      if (list) targets = JSON.parse(list.targets).map(t => ({ query: t, name: t }));
    } else if (scanType === "competitor") {
      const comp = db.prepare("SELECT name, ads_id FROM competitors WHERE id = ?").get(targetId);
      if (comp) targets = [{ query: comp.ads_id || comp.name, name: comp.name }];
    } else {
      targets = [{ query: searchQuery, name: searchQuery }];
    }

    if (targets.length === 0) return res.status(400).json({ error: "No targets specified" });

    const fixUrl = (url) => url && url.startsWith('//') ? 'https:' + url : url;
    let allResults = [];
    let isolatedScanData = []; 

    for (let tIndex = 0; tIndex < targets.length; tIndex++) {
      const targetQuery = targets[tIndex].query;
      const targetDisplayName = targets[tIndex].name;

      const results = await scanCompetitor(targetQuery, targetCountry, limit, (progressData) => {
        scanEvents.emit("progress", {
          ...progressData, target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length
        });
      });
      
      let compQuery = db.prepare("SELECT id, ads_id FROM competitors WHERE name = ?").get(targetDisplayName);
      let competitorId;
      if (!compQuery) {
        const resComp = db.prepare("INSERT INTO competitors (name, ads_id, country) VALUES (?, ?, ?)").run(targetDisplayName, targetQuery.startsWith('AR') ? targetQuery : null, targetCountry);
        competitorId = resComp.lastInsertRowid;
      } else {
        competitorId = compQuery.id;
        if (!compQuery.ads_id && targetQuery.startsWith('AR')) {
           db.prepare("UPDATE competitors SET ads_id = ? WHERE id = ?").run(targetQuery, competitorId);
        }
      }

      // --- SPEED OPTIMIZATION: ONLY FETCH UNIQUE GAMES ---
      const adCounts = {};
      results.forEach(pkg => { adCounts[pkg] = (adCounts[pkg] || 0) + 1; });
      const uniquePackages = [...new Set(results)];

      for (let i = 0; i < uniquePackages.length; i++) {
        const pkg = uniquePackages[i];
        
        scanEvents.emit("progress", {
          target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
          currentAd: limit, totalAds: limit, timeRemaining: "00:00",
          log: `> ⏳ Fetching live Play Store data for: ${pkg}... (${i+1}/${uniquePackages.length})`
        });

        try {
          const appData = await gplay.app({ appId: pkg, country: 'us' });
          const pubName = appData.developer || "Unknown Publisher";
          const normalizedPub = pubName.toLowerCase().replace(/[^a-z0-9]/g, "");
          
          let similarApps = [];
          try {
            const rawSimilar = await gplay.similar({ appId: pkg, country: 'us' });
            similarApps = (rawSimilar || []).slice(0, 6).map(sim => ({
              title: sim.title, appId: sim.appId, developer: sim.developer, icon: fixUrl(sim.icon), score: sim.score || 0
            }));
          } catch (simErr) { similarApps = []; }

          let accQuery = db.prepare("SELECT id FROM accounts WHERE publisher_name = ? AND competitor_id = ?").get(pubName, competitorId);
          let accountId;
          if (!accQuery) {
            const resAcc = db.prepare("INSERT INTO accounts (competitor_id, publisher_name, normalized_name) VALUES (?, ?, ?)").run(competitorId, pubName, normalizedPub);
            accountId = resAcc.lastInsertRowid;
          } else { accountId = accQuery.id; }

          const iconUrl = fixUrl(appData.icon);
          const screenshotsArray = (appData.screenshots || []).map(fixUrl);

          const insertGame = db.prepare(`
            INSERT INTO games (package_name, title, category, rating, ratings_count, icon, screenshots, description, installs, min_installs, released, updated, similar_apps, ad_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(package_name) DO UPDATE SET 
              title=excluded.title, category=excluded.category, rating=excluded.rating, ratings_count=excluded.ratings_count,
              icon=excluded.icon, screenshots=excluded.screenshots, description=excluded.description,
              installs=excluded.installs, min_installs=excluded.min_installs, released=excluded.released, updated=excluded.updated,
              similar_apps=excluded.similar_apps,
              ad_count=excluded.ad_count
          `);
          
          insertGame.run(
            pkg, appData.title, appData.genre, appData.score || 0, appData.ratings || 0, 
            iconUrl, JSON.stringify(screenshotsArray), appData.description,
            appData.installs || "0+", appData.minInstalls || 0, appData.released || "Unknown", appData.updated || 0,
            JSON.stringify(similarApps),
            adCounts[pkg] 
          );
          
          const gameQuery = db.prepare("SELECT id FROM games WHERE package_name = ?").get(pkg);
          db.prepare("INSERT OR IGNORE INTO account_games (account_id, game_id) VALUES (?, ?)").run(accountId, gameQuery.id);

          isolatedScanData.push({
            title: appData.title, publisher_name: pubName, category: appData.genre, rating: appData.score || 0, installs: appData.installs || "0+"
          });

          scanEvents.emit("progress", {
            target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
            currentAd: limit, totalAds: limit, timeRemaining: "00:00",
            log: `> 🎯 Saved: ${appData.title} (${similarApps.length} clones, ${adCounts[pkg]} ads)`
          });
        } catch (err) {
          scanEvents.emit("progress", {
            target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
            currentAd: limit, totalAds: limit, timeRemaining: "00:00",
            log: `> ⚠️ Play Store fetch failed for ${pkg}: Geo-locked or Removed`
          });
        }
      }
      
      scanEvents.emit("progress", {
        target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
        currentAd: limit, totalAds: limit, timeRemaining: "00:00",
        log: `> 📊 Syncing data snapshot to Google Sheets...`
      });
      
      try { await pushScanToSheets(db, targetDisplayName, results); } catch (e) { console.error("Sheets Sync Error:", e); }
      
      allResults.push(...results);
    } // End of Batch Loop

    scanEvents.emit("progress", {
      target: "All Scans Complete", targetIndex: targets.length, totalTargets: targets.length,
      currentAd: limit, totalAds: limit, timeRemaining: "00:00",
      log: `> 🎉 BATCH COMPLETE! Dashboard updating...`
    });

    // --- STRICT EMAIL LOGIC ---
    // Evaluates strictly true, entirely bypassing "none" ghosts.
    const isReportRequested = sendReport === true && emailListId && emailListId !== "none";

    if (isReportRequested && isolatedScanData.length > 0) {
      scanEvents.emit("progress", {
        target: "Generating Report", targetIndex: targets.length, totalTargets: targets.length,
        currentAd: limit, totalAds: limit, timeRemaining: "00:00",
        log: `> ✉️ Generating isolated PDF report and sending email...`
      });
      
      try {
        const emailRow = db.prepare("SELECT emails FROM email_lists WHERE id = ?").get(emailListId);
        if (emailRow) {
          const emailString = JSON.parse(emailRow.emails).join(", ");
          const { generateAndSendReport } = require("./AutomatedReport");
          
          await generateAndSendReport(emailString, isolatedScanData);
          
          scanEvents.emit("progress", {
            target: "Generating Report", targetIndex: targets.length, totalTargets: targets.length,
            currentAd: limit, totalAds: limit, timeRemaining: "00:00",
            log: `> ✅ Email successfully dispatched to targets!`
          });
        }
      } catch (err) { console.error("Email Dispatch Error:", err); }
    }

    res.json({ status: "success", data: allResults });
  } catch (error) {
    console.error("Scan Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/competitors", (req, res) => {
  const { name, adsId, country } = req.body;
  if (!name) return res.status(400).json({ error: "Competitor name is required" });

  const result = db.prepare("INSERT INTO competitors (name, ads_id, country) VALUES (?, ?, ?)").run(name, adsId || null, country || null);
  res.json({ id: result.lastInsertRowid, name, adsId: adsId || null, country: country || null });
});

app.post("/api/accounts", (req, res) => {
  const { competitorId, publisherName, country, status } = req.body;
  if (!publisherName) return res.status(400).json({ error: "Publisher name is required" });

  const normalized = publisherName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const result = db.prepare("INSERT INTO accounts (competitor_id, publisher_name, normalized_name, country, status) VALUES (?, ?, ?, ?, ?)").run(competitorId || null, publisherName, normalized, country || null, status || "active");
  res.json({ id: result.lastInsertRowid, competitorId, publisherName, normalizedName: normalized, country: country || null, status: status || "active" });
});

app.post("/api/games", (req, res) => {
  const { accountId, packageName, title, rating, ratingsCount, category } = req.body;
  if (!packageName || !title) return res.status(400).json({ error: "Package name and title are required" });

  const insertGame = db.prepare(`
    INSERT INTO games (package_name, title, rating, ratings_count, category) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(package_name) DO UPDATE SET title = excluded.title, rating = excluded.rating, ratings_count = excluded.ratings_count, last_seen = CURRENT_TIMESTAMP
  `);
  insertGame.run(packageName, title, rating || null, ratingsCount || 0, category || null);
  
  const game = db.prepare("SELECT id FROM games WHERE package_name = ?").get(packageName);

  if (accountId) {
    db.prepare("INSERT OR IGNORE INTO account_games (account_id, game_id) VALUES (?, ?)").run(accountId, game.id);
  }
  res.json({ id: game.id, packageName, title, linkedAccountId: accountId || null });
});

app.get("/api/competitors", (req, res) => {
  const competitors = db.prepare("SELECT * FROM competitors").all();
  
  const fullTree = competitors.map((comp) => {
    const accounts = db.prepare("SELECT * FROM accounts WHERE competitor_id = ?").all(comp.id);
    const accountsWithGames = accounts.map((acc) => {
      const games = db.prepare(`
        SELECT g.* FROM games g
        JOIN account_games ag ON g.id = ag.game_id
        WHERE ag.account_id = ?
      `).all(acc.id);
      return { ...acc, games };
    });
    return { ...comp, accounts: accountsWithGames };
  });

  res.json(fullTree);
});

const PORT = 3000;

cron.schedule('0 3 * * *', async () => {
  console.log("\n👻 [GHOST AUTOMATION] Waking up. Initiating scheduled background scans...");

  try {
    const targets = db.prepare("SELECT name, country FROM competitors").all();
    if (targets.length === 0) {
      console.log("👻 [GHOST AUTOMATION] No targets found in database. Going back to sleep.");
      return;
    }

    for (const target of targets) {
      console.log(`\n👻 [GHOST AUTOMATION] Initiating silent scan for: ${target.name}`);
      await scanCompetitor(target.name, target.country || "Any", 500, (progress) => {
        if (progress.log && progress.log.includes('✅')) {
          console.log(`   ${progress.log}`);
        }
      });
      console.log(`👻 [GHOST AUTOMATION] Target complete. Cooling down for 30 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    console.log("\n👻 [GHOST AUTOMATION] All scheduled scans complete. Database is primed for the day.");
  } catch (error) {
    console.error("👻 [GHOST AUTOMATION] Critical failure in background task:", error);
  }
});

cron.schedule('0 6 * * *', async () => {
  console.log("\n⏰ [CRON] Triggering 6:00 AM Automated PDF Report...");
  const managerEmail = "danish1042awan@gmail.com"; 
  await generateAndSendReport(managerEmail);
});

app.listen(PORT, () => {
  console.log(`Atlas backend running on http://localhost:${PORT}`);
});