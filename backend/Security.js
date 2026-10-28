const crypto = require("crypto");
const { Pool } = require("pg");

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MIN_SESSION_SECRET_BYTES = 32;
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;
const LEGACY_PUBLIC_DEFAULTS = Object.freeze([
  { username: "admin", hash: "9cf40b7687e71c2fdac833a914cfa941b31352624d4fac6bf23150e2d3ca86a4" },
  { username: "user", hash: "e606e38b0d8c19b24cf0ee3808183162ea7cd63ff7912dbb22b5e803286b4446" }
]);

let sharedPool = null;

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function normalizePem(value) {
  const text = String(value || "").trim();
  return text ? text.replace(/\\n/g, "\n") : null;
}

function sanitizeConnectionString(rawConnectionString) {
  const raw = String(rawConnectionString || "").trim();
  if (!raw) throw new Error("DATABASE_URL is required.");

  try {
    const url = new URL(raw);
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      url.searchParams.delete(key);
    }
    // Supabase Pooler on port 5432 is Session Mode (hard capped to 15 connections).
    // Automatically use port 6543 (Transaction Mode) to prevent EMAXCONNSESSION errors.
    if (url.hostname.includes("pooler.supabase.com") && (!url.port || url.port === "5432")) {
      url.port = "6543";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function databaseHost(rawConnectionString) {
  try {
    return new URL(rawConnectionString).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

function createDatabaseConfig() {
  const rawConnectionString = String(process.env.DATABASE_URL || "").trim();
  if (!rawConnectionString) throw new Error("DATABASE_URL is required.");

  const host = databaseHost(rawConnectionString);
  const localDatabase = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const requestedMode = String(
    process.env.DATABASE_SSL_MODE || (localDatabase ? "disable" : "verify-full")
  ).trim().toLowerCase();
  const allowInsecure = envFlag("ATLAS_ALLOW_INSECURE_DB_TLS");

  let ssl;
  if (["disable", "off", "false"].includes(requestedMode)) {
    if (!localDatabase && !allowInsecure) {
      throw new Error(
        "Refusing an unencrypted remote database connection. Use verified TLS or explicitly set ATLAS_ALLOW_INSECURE_DB_TLS=true only for a trusted private network."
      );
    }
    if (!localDatabase) {
      console.warn("⚠️ [SECURITY] Remote database TLS is explicitly disabled.");
    }
    ssl = false;
  } else if (["no-verify", "insecure", "require"].includes(requestedMode)) {
    if (!allowInsecure) {
      throw new Error(
        "DATABASE_SSL_MODE requests TLS without certificate verification. Use verify-full, or explicitly opt in with ATLAS_ALLOW_INSECURE_DB_TLS=true."
      );
    }
    console.warn("⚠️ [SECURITY] Database TLS certificate verification is explicitly disabled.");
    ssl = { rejectUnauthorized: false };
  } else if (["verify", "verify-full", "verify-ca"].includes(requestedMode)) {
    const ca = normalizePem(process.env.DATABASE_CA_CERT);
    ssl = {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {})
    };
  } else {
    throw new Error("Unsupported DATABASE_SSL_MODE: " + requestedMode);
  }

  return {
    connectionString: sanitizeConnectionString(rawConnectionString),
    ssl
  };
}

// Atlas uses one process-wide pool for the main API, extensions and scanners.
// keepAlive keeps remote Supabase TLS sockets warm so mutations don't pay a
// fresh TCP+TLS handshake cost after brief idle periods.
function getDatabasePool() {
  if (sharedPool) return sharedPool;

  const requestedMax = Number(process.env.ATLAS_DB_POOL_MAX || 10);
  const max = Number.isInteger(requestedMax) && requestedMax >= 1 && requestedMax <= 20
    ? requestedMax
    : 10;

  const connectionConfig = process.env.DATABASE_URL
    ? createDatabaseConfig()
    : isProduction()
      ? createDatabaseConfig()
      : {};

  sharedPool = new Pool({
    ...connectionConfig,
    connectionTimeoutMillis: 8000,
    max,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  });

  sharedPool.on("error", (err) => {
    console.warn("⚠️ [DB Pool] Idle client error (recovered automatically):", err.message);
  });

  return sharedPool;
}

function getSessionSecret() {
  const configured = String(process.env.ATLAS_SESSION_SECRET || "").trim();
  const configuredBytes = Buffer.byteLength(configured, "utf8");

  if (configuredBytes >= MIN_SESSION_SECRET_BYTES) return configured;

  if (isProduction()) {
    if (!configured) {
      throw new Error("ATLAS_SESSION_SECRET must be set in production.");
    }
    throw new Error("ATLAS_SESSION_SECRET must be at least " + MIN_SESSION_SECRET_BYTES + " bytes in production.");
  }

  console.warn(
    "⚠️ [AUTH] ATLAS_SESSION_SECRET is missing or too short. Using a development-only ephemeral secret; sessions reset on restart."
  );
  return crypto.randomBytes(48).toString("base64url");
}

function deriveScryptKey(password, salt, options = SCRYPT_PARAMS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  const value = String(password ?? "");
  if (!value) throw new Error("Password cannot be empty.");

  const salt = crypto.randomBytes(16);
  const derivedKey = await deriveScryptKey(value, salt);
  return [
    "scrypt",
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    salt.toString("base64"),
    derivedKey.toString("base64")
  ].join("$");
}

function timingSafeEqualBuffers(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function verifyPassword(password, storedHash) {
  const value = String(password ?? "");
  const encoded = String(storedHash || "").trim();

  if (encoded.startsWith("scrypt$")) {
    const parts = encoded.split("$");
    if (parts.length !== 6) return { valid: false, needsUpgrade: false };

    const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);

    if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) {
      return { valid: false, needsUpgrade: false };
    }

    try {
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(hashB64, "base64");
      if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) {
        return { valid: false, needsUpgrade: false };
      }
      const actual = await deriveScryptKey(value, salt);
      return { valid: timingSafeEqualBuffers(actual, expected), needsUpgrade: false };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  if (/^[a-f0-9]{64}$/i.test(encoded)) {
    const actual = Buffer.from(crypto.createHash("sha256").update(value).digest("hex"), "hex");
    const expected = Buffer.from(encoded, "hex");
    const valid = timingSafeEqualBuffers(actual, expected);
    return { valid, needsUpgrade: valid };
  }

  return { valid: false, needsUpgrade: false };
}

async function initializeAuthStorage(pool) {
  await pool.query([
    "CREATE TABLE IF NOT EXISTS users (",
    "  id SERIAL PRIMARY KEY,",
    "  username VARCHAR(50) UNIQUE NOT NULL,",
    "  password_hash VARCHAR(255) NOT NULL,",
    "  role VARCHAR(20) NOT NULL DEFAULT 'view-only',",
    "  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP",
    ");"
  ].join("\n"));

  await pool.query([
    "UPDATE users",
    "SET role = 'admin'",
    "WHERE LOWER(TRIM(role)) IN ('admin', 'full access', 'full-access', 'full_access')"
  ].join("\n"));

  for (const legacy of LEGACY_PUBLIC_DEFAULTS) {
    const removed = await pool.query(
      "DELETE FROM users " +
      "WHERE LOWER(username) = LOWER($1) " +
      "AND LOWER(password_hash) = LOWER($2) RETURNING id",
      [legacy.username, legacy.hash]
    );
    if (removed.rowCount > 0) {
      console.warn("⚠️ [AUTH] Removed insecure legacy default account: " + legacy.username);
    }
  }

  const adminCount = Number((await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"
  )).rows[0]?.count || 0);

  // Ensure default view-only account exists if configured or requested
  const viewUsername = String(process.env.ATLAS_BOOTSTRAP_USER_USERNAME || "user").trim();
  const viewPassword = String(process.env.ATLAS_BOOTSTRAP_USER_PASSWORD || "user123");
  if (viewUsername && viewPassword) {
    const existingViewUser = (await pool.query(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
      [viewUsername]
    )).rows[0];
    if (!existingViewUser) {
      const viewHash = await hashPassword(viewPassword);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'view-only')",
        [viewUsername, viewHash]
      );
      console.log("👤 [AUTH] Bootstrapped view-only account: " + viewUsername);
    }
  }

  if (adminCount > 0) return;

  const username = String(process.env.ATLAS_BOOTSTRAP_ADMIN_USERNAME || "").trim();
  const password = String(process.env.ATLAS_BOOTSTRAP_ADMIN_PASSWORD || "");

  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      "Set both ATLAS_BOOTSTRAP_ADMIN_USERNAME and ATLAS_BOOTSTRAP_ADMIN_PASSWORD to bootstrap the first admin."
    );
  }

  if (username && password) {
    if (username.length > 50) {
      throw new Error("ATLAS_BOOTSTRAP_ADMIN_USERNAME must be 50 characters or fewer.");
    }
    if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
      throw new Error("ATLAS_BOOTSTRAP_ADMIN_PASSWORD must be at least " + MIN_BOOTSTRAP_PASSWORD_LENGTH + " characters.");
    }

    const passwordHash = await hashPassword(password);
    const existing = (await pool.query(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1) ORDER BY id ASC LIMIT 1",
      [username]
    )).rows[0];

    if (existing) {
      await pool.query(
        "UPDATE users SET username = $2, password_hash = $3, role = 'admin' WHERE id = $1",
        [existing.id, username, passwordHash]
      );
    } else {
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        [username, passwordHash]
      );
    }

    console.log("👤 [AUTH] Bootstrapped admin account from environment: " + username);
    return;
  }

  const message =
    "No admin account exists. Set ATLAS_BOOTSTRAP_ADMIN_USERNAME and ATLAS_BOOTSTRAP_ADMIN_PASSWORD to create the first admin.";

  if (isProduction()) throw new Error(message);
  console.warn("⚠️ [AUTH] " + message);
}

module.exports = {
  createDatabaseConfig,
  getDatabasePool,
  getSessionSecret,
  hashPassword,
  verifyPassword,
  initializeAuthStorage,
  isProduction
};