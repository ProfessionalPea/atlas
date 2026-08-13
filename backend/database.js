const Database = require("better-sqlite3");

const db = new Database("atlas.db");

db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ads_id TEXT,
    country TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    country TEXT,
    status TEXT DEFAULT 'active',
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
  );

    CREATE TABLE IF NOT EXISTS competitor_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,

    FOREIGN KEY (competitor_id) REFERENCES competitors(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),

    UNIQUE(competitor_id, account_id)
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT UNIQUE,
    title TEXT NOT NULL,
    rating REAL,
    ratings_count INTEGER,
    category TEXT,
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS account_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (game_id) REFERENCES games(id),

    UNIQUE(account_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    rating REAL,
    ratings_count INTEGER,
    downloads INTEGER,
    icon_url TEXT,
    short_description TEXT,

    FOREIGN KEY (game_id) REFERENCES games(id)
  );
`);

module.exports = db;