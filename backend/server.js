const express = require("express");
const cors = require("cors");

const db = require("./database");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Atlas backend is running"
  });
});

app.get("/api/stats", (req, res) => {
  const competitors = db
    .prepare("SELECT COUNT(*) AS count FROM competitors")
    .get().count;

  const accounts = db
    .prepare("SELECT COUNT(*) AS count FROM accounts")
    .get().count;

  const games = db
    .prepare("SELECT COUNT(*) AS count FROM games")
    .get().count;

  res.json({
    competitors,
    accounts,
    games
  });
});


app.post("/api/competitors", (req, res) => {
  const { name, adsId, country } = req.body;

  if (!name) {
    return res.status(400).json({
      error: "Competitor name is required"
    });
  }

  const result = db
    .prepare(`
      INSERT INTO competitors (name, ads_id, country)
      VALUES (?, ?, ?)
    `)
    .run(name, adsId || null, country || null);

  res.json({
    id: result.lastInsertRowid,
    name,
    adsId: adsId || null,
    country: country || null
  });
});

app.post("/api/accounts", (req, res) => {
  const { publisherName, normalizedName, country, status } = req.body;

  if (!publisherName) {
    return res.status(400).json({
      error: "Publisher name is required"
    });
  }

  const result = db
    .prepare(`
      INSERT INTO accounts (
        publisher_name,
        normalized_name,
        country,
        status
      )
      VALUES (?, ?, ?, ?)
    `)
    .run(
      publisherName,
      normalizedName || publisherName.toLowerCase(),
      country || null,
      status || "active"
    );

  res.json({
    id: result.lastInsertRowid,
    publisherName,
    normalizedName: normalizedName || publisherName.toLowerCase(),
    country: country || null,
    status: status || "active"
  });
});

app.post("/api/competitor-accounts", (req, res) => {
  const { competitorId, accountId } = req.body;

  if (!competitorId || !accountId) {
    return res.status(400).json({
      error: "competitorId and accountId are required"
    });
  }

  try {
    const result = db
      .prepare(`
        INSERT INTO competitor_accounts (
          competitor_id,
          account_id
        )
        VALUES (?, ?)
      `)
      .run(competitorId, accountId);

    res.json({
      id: result.lastInsertRowid,
      competitorId,
      accountId
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

app.post("/api/games", (req, res) => {
  const {
    packageName,
    title,
    rating,
    ratingsCount,
    category
  } = req.body;

  if (!packageName || !title) {
    return res.status(400).json({
      error: "packageName and title are required"
    });
  }

  try {
    const result = db
      .prepare(`
        INSERT INTO games (
          package_name,
          title,
          rating,
          ratings_count,
          category
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        packageName,
        title,
        rating || null,
        ratingsCount || null,
        category || null
      );

    res.json({
      id: result.lastInsertRowid,
      packageName,
      title,
      rating: rating || null,
      ratingsCount: ratingsCount || null,
      category: category || null
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

app.post("/api/account-games", (req, res) => {
  const { accountId, gameId } = req.body;

  if (!accountId || !gameId) {
    return res.status(400).json({
      error: "accountId and gameId are required"
    });
  }

  try {
    const result = db
      .prepare(`
        INSERT INTO account_games (
          account_id,
          game_id
        )
        VALUES (?, ?)
      `)
      .run(accountId, gameId);

    res.json({
      id: result.lastInsertRowid,
      accountId,
      gameId
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

app.get("/api/competitors", (req, res) => {
  const competitors = db
    .prepare("SELECT * FROM competitors ORDER BY name")
    .all();

  const getAccounts = db.prepare(`
    SELECT
      accounts.id,
      accounts.publisher_name,
      accounts.normalized_name,
      accounts.country,
      accounts.status
    FROM accounts
    JOIN competitor_accounts
      ON accounts.id = competitor_accounts.account_id
    WHERE competitor_accounts.competitor_id = ?
    ORDER BY accounts.publisher_name
  `);

  const getGames = db.prepare(`
    SELECT
      games.id,
      games.package_name,
      games.title,
      games.rating,
      games.ratings_count,
      games.category
    FROM games
    JOIN account_games
      ON games.id = account_games.game_id
    WHERE account_games.account_id = ?
    ORDER BY games.title
  `);

  const result = competitors.map((competitor) => {
    const accounts = getAccounts
      .all(competitor.id)
      .map((account) => ({
        ...account,
        games: getGames.all(account.id)
      }));

    return {
      ...competitor,
      accounts
    };
  });

  res.json(result);
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Atlas backend running on http://localhost:${PORT}`);
});