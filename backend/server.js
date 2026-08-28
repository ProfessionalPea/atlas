const { generateAndSendReport } = require("./AutomatedReport");
const { scanCompetitor } = require("./GoogleAdsScanner");
const { pushScanToSheets } = require("./GoogleSheetsSync"); // <--- ADD THIS
const EventEmitter = require('events');
const cron = require('node-cron');
const express = require("express");
const cors = require("cors");
const fs = require("fs"); 
const db = require("./database");

// Auto-upgrade DB to hold Icons and Screenshots
try {
  db.prepare("ALTER TABLE games ADD COLUMN icon TEXT").run();
  db.prepare("ALTER TABLE games ADD COLUMN screenshots TEXT").run();
  db.prepare("ALTER TABLE games ADD COLUMN description TEXT").run();
} catch (e) {
  // Columns already exist, safely ignore
}

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

app.post("/api/reset", (req, res) => {
  try {
    console.log("🧹 NUKE INITIATED: Wiping all database tables...");
    
    // Delete data from all tables
    db.prepare("DELETE FROM account_games").run();
    db.prepare("DELETE FROM games").run();
    db.prepare("DELETE FROM accounts").run();
    db.prepare("DELETE FROM competitors").run();
    
    console.log("✨ Database is now completely empty.");
    res.json({ status: "success", message: "Database reset complete" });
  } catch (err) {
    console.error("Failed to reset database:", err);
    res.status(500).json({ error: "Failed to reset database" });
  }
});

app.get("/api/trending", (req, res) => {
  try {
    const trendingGames = db.prepare(`
      SELECT 
        g.id, g.title, g.package_name, g.category, 
        g.icon, g.screenshots, g.description, 
        a.publisher_name, 
        c.name as competitor_name
      FROM games g
      JOIN account_games ag ON g.id = ag.game_id
      JOIN accounts a ON ag.account_id = a.id
      JOIN competitors c ON a.competitor_id = c.id
      ORDER BY g.id DESC
      LIMIT 10
    `).all();
    
    res.json(trendingGames);
  } catch (err) {
    console.error("Failed to load trending:", err);
    res.status(500).json({ error: "Failed to load trending targets" });
  }
});

// ----------------------------------------------------
// TARGET LISTS ROUTES (AUTOMATED SCANS)
// ----------------------------------------------------

// Get all lists
app.get("/api/lists", (req, res) => {
  try {
    const lists = db.prepare("SELECT * FROM target_lists ORDER BY created_at DESC").all();
    // Parse the targets from JSON string back to array for the frontend
    const parsedLists = lists.map(list => ({ ...list, targets: JSON.parse(list.targets) }));
    res.json(parsedLists);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lists" });
  }
});

// Create a new list
app.post("/api/lists", (req, res) => {
  const { name, targets } = req.body;
  if (!name || !targets || !Array.isArray(targets)) return res.status(400).json({ error: "Invalid data" });
  
  try {
    const result = db.prepare("INSERT INTO target_lists (name, targets) VALUES (?, ?)").run(name, JSON.stringify(targets));
    res.json({ id: result.lastInsertRowid, name, targets, is_active: 1 });
  } catch (err) {
    res.status(500).json({ error: "Failed to create list" });
  }
});

// Toggle a list on/off
app.patch("/api/lists/:id/toggle", (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try {
    db.prepare("UPDATE target_lists SET is_active = ? WHERE id = ?").run(is_active ? 1 : 0, id);
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle list" });
  }
});

// Delete a list
app.delete("/api/lists/:id", (req, res) => {
  const { id } = req.params;
  try {
    db.prepare("DELETE FROM target_lists WHERE id = ?").run(id);
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete list" });
  }
});

// --- SAVED COMPETITORS MANAGEMENT ---

// Auto-upgrade DB to ensure we have the ads_id column
try {
  db.prepare("ALTER TABLE competitors ADD COLUMN ads_id TEXT").run();
} catch (e) {
  // Column exists, ignore
}

// Get flat list of saved competitors for the UI
app.get("/api/saved-competitors", (req, res) => {
  try {
    const comps = db.prepare("SELECT * FROM competitors WHERE ads_id IS NOT NULL ORDER BY id DESC").all();
    res.json(comps);
  } catch(err) {
    res.status(500).json({error: "Failed to fetch saved competitors"});
  }
});

// Delete a saved competitor
app.delete("/api/saved-competitors/:id", (req, res) => {
  const { id } = req.params;
  try {
    // Delete their accounts, games, and the competitor itself
    const accounts = db.prepare("SELECT id FROM accounts WHERE competitor_id = ?").all(id);
    accounts.forEach(acc => {
      db.prepare("DELETE FROM account_games WHERE account_id = ?").run(acc.id);
    });
    db.prepare("DELETE FROM accounts WHERE competitor_id = ?").run(id);
    db.prepare("DELETE FROM competitors WHERE id = ?").run(id);
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete competitor" });
  }
});

app.get("/api/scan-stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform", // Forces real-time delivery
    "Connection": "keep-alive"
  });
  
  // Send a heartbeat to force the pipe open
  res.write(`data: ${JSON.stringify({ log: "> Secure SSE connection established..." })}\n\n`);

  const sendProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  scanEvents.on("progress", sendProgress);

  req.on("close", () => {
    scanEvents.off("progress", sendProgress);
  });
});

// --- UPDATED: Scan Route ---
// --- FULLY ASSEMBLED SCAN ROUTE ---
// --- UPGRADED: BATCH SCAN ROUTE ---
// --- UPGRADED: SMART BATCH SCAN ROUTE ---
app.post("/api/scan", async (req, res) => {
  // scanType will be 'manual', 'list', or 'competitor'
  const { searchQuery, scanType, targetId, targetCountry, limit } = req.body;
  
  try {
    let targets = []; // Array of { query: string, name: string }
    
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

    // --- THE BATCH LOOP ---
    for (let tIndex = 0; tIndex < targets.length; tIndex++) {
      const targetQuery = targets[tIndex].query;
      const targetDisplayName = targets[tIndex].name;

      const results = await scanCompetitor(targetQuery, targetCountry, limit, (progressData) => {
        scanEvents.emit("progress", {
          ...progressData,
          target: targetDisplayName,
          targetIndex: tIndex + 1,
          totalTargets: targets.length
        });
      });
      
      let compQuery = db.prepare("SELECT id, ads_id FROM competitors WHERE name = ?").get(targetDisplayName);
      let competitorId;
      if (!compQuery) {
        const resComp = db.prepare("INSERT INTO competitors (name, ads_id, country) VALUES (?, ?, ?)").run(targetDisplayName, targetQuery.startsWith('AR') ? targetQuery : null, targetCountry);
        competitorId = resComp.lastInsertRowid;
      } else {
        competitorId = compQuery.id;
        // Auto-update ads_id if we didn't have it before
        if (!compQuery.ads_id && targetQuery.startsWith('AR')) {
           db.prepare("UPDATE competitors SET ads_id = ? WHERE id = ?").run(targetQuery, competitorId);
        }
      }

      // Play Store Scraper Loop
      for (let i = 0; i < results.length; i++) {
        const pkg = results[i];
        
        scanEvents.emit("progress", {
          target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
          currentAd: limit, totalAds: limit, timeRemaining: "00:00",
          log: `> ⏳ Fetching live Play Store data for: ${pkg}... (${i+1}/${results.length})`
        });

        try {
          const appData = await gplay.app({ appId: pkg, country: 'us' });
          const pubName = appData.developer || "Unknown Publisher";
          const normalizedPub = pubName.toLowerCase().replace(/[^a-z0-9]/g, "");
          
          let accQuery = db.prepare("SELECT id FROM accounts WHERE publisher_name = ? AND competitor_id = ?").get(pubName, competitorId);
          let accountId;
          if (!accQuery) {
            const resAcc = db.prepare("INSERT INTO accounts (competitor_id, publisher_name, normalized_name) VALUES (?, ?, ?)").run(competitorId, pubName, normalizedPub);
            accountId = resAcc.lastInsertRowid;
          } else {
            accountId = accQuery.id;
          }

          const iconUrl = fixUrl(appData.icon);
          const screenshotsArray = (appData.screenshots || []).map(fixUrl);

          const insertGame = db.prepare(`
            INSERT INTO games (package_name, title, category, rating, ratings_count, icon, screenshots, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(package_name) DO UPDATE SET 
              title=excluded.title, category=excluded.category, rating=excluded.rating, ratings_count=excluded.ratings_count,
              icon=excluded.icon, screenshots=excluded.screenshots, description=excluded.description
          `);
          
          insertGame.run(pkg, appData.title, appData.genre, appData.score || 0, appData.ratings || 0, iconUrl, JSON.stringify(screenshotsArray), appData.description);
          const gameQuery = db.prepare("SELECT id FROM games WHERE package_name = ?").get(pkg);
          db.prepare("INSERT OR IGNORE INTO account_games (account_id, game_id) VALUES (?, ?)").run(accountId, gameQuery.id);

          scanEvents.emit("progress", {
            target: targetDisplayName, targetIndex: tIndex + 1, totalTargets: targets.length,
            currentAd: limit, totalAds: limit, timeRemaining: "00:00",
            log: `> ✅ Saved: ${appData.title} (Pub: ${pubName})`
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
      
      // Ensure GoogleSheetsSync.js handles this safely!
      try {
        await pushScanToSheets(db, targetDisplayName, results);
      } catch (e) {
        console.error("Sheets Sync Error:", e);
      }
      
      allResults.push(...results);
    } // End of Batch Loop

    scanEvents.emit("progress", {
      target: "All Scans Complete", targetIndex: targets.length, totalTargets: targets.length,
      currentAd: limit, totalAds: limit, timeRemaining: "00:00",
      log: `> 🎉 BATCH COMPLETE! Dashboard updating...`
    });

    res.json({ status: "success", data: allResults });
  } catch (error) {
    console.error("Scan Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 1. Create a Competitor
app.post("/api/competitors", (req, res) => {
  const { name, adsId, country } = req.body;
  if (!name) return res.status(400).json({ error: "Competitor name is required" });

  const result = db.prepare("INSERT INTO competitors (name, ads_id, country) VALUES (?, ?, ?)").run(name, adsId || null, country || null);
  res.json({ id: result.lastInsertRowid, name, adsId: adsId || null, country: country || null });
});

// 2. Add an Account linked to a Competitor
app.post("/api/accounts", (req, res) => {
  const { competitorId, publisherName, country, status } = req.body;
  if (!publisherName) return res.status(400).json({ error: "Publisher name is required" });

  const normalized = publisherName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const result = db.prepare("INSERT INTO accounts (competitor_id, publisher_name, normalized_name, country, status) VALUES (?, ?, ?, ?, ?)").run(competitorId || null, publisherName, normalized, country || null, status || "active");
  res.json({ id: result.lastInsertRowid, competitorId, publisherName, normalizedName: normalized, country: country || null, status: status || "active" });
});

// 3. Add a Game and Link it to an Account
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

// 4. Get All Competitors with their Accounts & Games
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

// ==========================================
// 👻 THE GHOST AUTOMATION (CRON JOBS)
// ==========================================

// Schedule: Runs every day at 3:00 AM ('0 3 * * *')
// For testing purposes right now, you can change '0 3 * * *' to '*/2 * * * *' to make it run every 2 minutes.
cron.schedule('0 3 * * *', async () => {
  console.log("\n👻 [GHOST AUTOMATION] Waking up. Initiating scheduled background scans...");

  try {
    // 1. Get a list of every competitor currently in your database
    const targets = db.prepare("SELECT name, country FROM competitors").all();

    if (targets.length === 0) {
      console.log("👻 [GHOST AUTOMATION] No targets found in database. Going back to sleep.");
      return;
    }

    // 2. Loop through them one by one
    for (const target of targets) {
      console.log(`\n👻 [GHOST AUTOMATION] Initiating silent scan for: ${target.name}`);
      
      // Run the scanner with a 500 ad limit. 
      // We pass a dummy callback because no UI is listening in the middle of the night!
      await scanCompetitor(target.name, target.country || "Any", 500, (progress) => {
        // Only log major milestones to the backend terminal to keep it clean
        if (progress.log && progress.log.includes('✅')) {
          console.log(`   ${progress.log}`);
        }
      });

      // 3. The Cooldown: Wait 30 seconds before hitting Google again so they don't block our IP
      console.log(`👻 [GHOST AUTOMATION] Target complete. Cooling down for 30 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    console.log("\n👻 [GHOST AUTOMATION] All scheduled scans complete. Database is primed for the day.");
  } catch (error) {
    console.error("👻 [GHOST AUTOMATION] Critical failure in background task:", error);
  }
});

// ==========================================
// ✉️ THE 6:00 AM MANAGER REPORT
// ==========================================

// Schedule: Runs every day at 6:00 AM ('0 6 * * *')
cron.schedule('0 6 * * *', async () => {
  console.log("\n⏰ [CRON] Triggering 6:00 AM Automated PDF Report...");
  
  // Replace this with your manager's actual email
  const managerEmail = "danish1042awan@gmail.com"; 
  
  await generateAndSendReport(managerEmail);
});

app.listen(PORT, () => {
  console.log(`Atlas backend running on http://localhost:${PORT}`);
});