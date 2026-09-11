const db = require("./database");

function normalizePublisherName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function processGame(gameData) {
  const normalizedPublisher = normalizePublisherName(
    gameData.publisherName
  );

  // Find existing account
  const existingAccount = db
    .prepare(`
      SELECT *
      FROM accounts
      WHERE normalized_name = ?
    `)
    .get(normalizedPublisher);

  let accountId;
  let accountStatus;

  if (existingAccount) {
    accountId = existingAccount.id;
    accountStatus = "existing";

    db.prepare(`
      UPDATE accounts
      SET
        publisher_name = ?,
        country = ?,
        last_seen = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      gameData.publisherName,
      gameData.country || null,
      accountId
    );
  } else {
    const accountResult = db
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
        gameData.publisherName,
        normalizedPublisher,
        gameData.country || null,
        "active"
      );

    accountId = accountResult.lastInsertRowid;
    accountStatus = "new";
  }

  // Find existing game
  const existingGame = db
    .prepare(`
      SELECT *
      FROM games
      WHERE package_name = ?
    `)
    .get(gameData.packageName);

  let gameId;
  let gameStatus;

  if (existingGame) {
    gameId = existingGame.id;
    gameStatus = "existing";

    db.prepare(`
      UPDATE games
      SET
        title = ?,
        rating = ?,
        ratings_count = ?,
        category = ?,
        last_seen = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      gameData.title,
      gameData.rating ?? null,
      gameData.ratingsCount ?? null,
      gameData.category ?? null,
      gameId
    );
  } else {
    const gameResult = db
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
        gameData.packageName,
        gameData.title,
        gameData.rating ?? null,
        gameData.ratingsCount ?? null,
        gameData.category ?? null
      );

    gameId = gameResult.lastInsertRowid;
    gameStatus = "new";
  }

  // Check whether account → game relationship already exists
  const relationshipExists = db
    .prepare(`
      SELECT *
      FROM account_games
      WHERE account_id = ?
        AND game_id = ?
    `)
    .get(accountId, gameId);

  let relationshipStatus;

  if (relationshipExists) {
    relationshipStatus = "existing";
  } else {
    db.prepare(`
      INSERT INTO account_games (
        account_id,
        game_id
      )
      VALUES (?, ?)
    `).run(accountId, gameId);

    relationshipStatus = "new";
  }

  return {
    account: {
      id: accountId,
      name: gameData.publisherName,
      normalizedName: normalizedPublisher,
      status: accountStatus
    },

    game: {
      id: gameId,
      title: gameData.title,
      packageName: gameData.packageName,
      status: gameStatus
    },

    relationship: {
      status: relationshipStatus
    }
  };
}

function processScan(games) {
  const results = [];

  let newGames = 0;
  let updatedGames = 0;
  let newAccounts = 0;
  let updatedAccounts = 0;
  let failed = 0;

  for (const game of games) {
    try {
      const result = processGame(game);

      results.push(result);

      if (result.game.status === "new") {
        newGames++;
      } else {
        updatedGames++;
      }

      if (result.account.status === "new") {
        newAccounts++;
      } else {
        updatedAccounts++;
      }
    } catch (error) {
      failed++;

      results.push({
        status: "failed",
        packageName: game.packageName,
        title: game.title,
        error: error.message
      });
    }
  }

    const scanResult = {
    gamesScanned: games.length,
    newGames,
    updatedGames,
    newAccounts,
    updatedAccounts,
    failed
  };

  db.prepare(`
    INSERT INTO scans (
      games_scanned,
      new_games,
      updated_games,
      new_accounts,
      updated_accounts,
      failed
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    scanResult.gamesScanned,
    scanResult.newGames,
    scanResult.updatedGames,
    scanResult.newAccounts,
    scanResult.updatedAccounts,
    scanResult.failed
  );

  return {
    summary: scanResult,
    results
  };
}

module.exports = {
  normalizePublisherName,
  processGame,
  processScan
};