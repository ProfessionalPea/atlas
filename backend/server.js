const express = require("express");
const cors = require("cors");
const db = require("./database");

const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// DASHBOARD & SCAN ROUTES
// ----------------------------------------------------

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Atlas backend is running" });
});

// Dashboard Stats
app.get("/api/stats", (req, res) => {
  const competitors = db.prepare("SELECT COUNT(*) AS count FROM competitors").get().count;
  const accounts = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
  const games = db.prepare("SELECT COUNT(*) AS count FROM games").get().count;

  res.json({ competitors, accounts, games });
});

// Trigger a Scan (Populates/Updates Competitor Data)
app.post("/api/scan", async (req, res) => {
  try {
    // The 3 real packages your Deep Scanner found earlier
    const packagesFound = [
      "com.gh.gangster.crime.city",
      "com.gttec.Speed.Keyboard.Parkour.Escape",
      "com.gtnw.dash.speed.hero.game"
    ];

    let newGamesCount = 0;
    let newAccountsCount = 0;

    // 1. Get or Create Playmax
    let comp = db.prepare("SELECT id FROM competitors WHERE name = ?").get("Playmax");
    if (!comp) {
      const compInsert = db.prepare("INSERT INTO competitors (name, ads_id) VALUES (?, ?)").run("Playmax", "Playmax");
      comp = { id: compInsert.lastInsertRowid };
    }

    // 2. Loop through the extracted packages
    for (const pkg of packagesFound) {
      try {
        console.log(`Fetching live data for: ${pkg}`);
        const appData = await gplay.app({ appId: pkg });
        
        const publisherName = appData.developer;
        const normalizedPub = publisherName.toLowerCase().replace(/[^a-z0-9]/g, "");

        // 3. Insert or find the Account dynamically
        let acc = db.prepare("SELECT id FROM accounts WHERE normalized_name = ?").get(normalizedPub);
        if (!acc) {
          const accInsert = db.prepare(
            "INSERT INTO accounts (competitor_id, publisher_name, normalized_name, status) VALUES (?, ?, ?, ?)"
          ).run(comp.id, publisherName, normalizedPub, "active");
          acc = { id: accInsert.lastInsertRowid };
          newAccountsCount++;
        }

        // 4. Insert or update the Game
        let game = db.prepare("SELECT id FROM games WHERE package_name = ?").get(pkg);
        if (!game) {
          const gameInsert = db.prepare(
            "INSERT INTO games (package_name, title, rating, ratings_count, category) VALUES (?, ?, ?, ?, ?)"
          ).run(pkg, appData.title, appData.score || 0, appData.reviews || 0, appData.genre || "Unknown");
          game = { id: gameInsert.lastInsertRowid };
          newGamesCount++;
        } else {
          db.prepare("UPDATE games SET rating = ?, ratings_count = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?")
            .run(appData.score || 0, appData.reviews || 0, game.id);
        }

        // 5. Link Account & Game
        db.prepare("INSERT OR IGNORE INTO account_games (account_id, game_id) VALUES (?, ?)").run(acc.id, game.id);

      } catch (err) {
        console.log(`❌ Failed to fetch ${pkg}: ${err.message}`);
      }
    }

    res.json({
      status: "success",
      message: "Scan completed",
      newAccounts: newAccountsCount,
      newGames: newGamesCount,
    });
  } catch (error) {
    console.error("Scan error:", error);
    res.status(500).json({ error: "Failed to complete scan" });
  }
});

// ----------------------------------------------------
// MANUAL CRUD ROUTES (The ones I accidentally deleted!)
// ----------------------------------------------------

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
app.listen(PORT, () => {
  console.log(`Atlas backend running on http://localhost:${PORT}`);
});