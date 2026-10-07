const crypto = require("crypto");
const { Pool } = require("pg");

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MIN_PRODUCTION_SECRET_BYTES = 32;
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

// SHA-256 digests of the historical public default passwords. Keeping only the
// digests lets Atlas identify and remove those known credentials without
// retaining the plaintext defaults in production source.
const LEGACY_PUBLIC_DEFAULTS = Object.freeze([
  { username: "admin", hash: "9cf40b7687e71c2fdac833a914cfa941b31352624d4fac6bf23150e2d3ca86a4" },
  { username: "user", hash: "e606e38b0d8c19b24cf0ee3808183162ea7cd63ff7912dbb22b5e803286b4446" }
]);

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
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
    // node-postgres connection-string SSL query parameters can override an
    // explicit ssl object. Strip them so the verified policy below wins.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function databaseHost(rawConnectionString) {
  try {
    return new URL(rawConnectionString).hostname.toLowerCase();
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
    if (isProduction() && !allowInsecure) {
      throw new Error(
        "Refusing to disable database TLS in production. Use verified TLS or explicitly set ATLAS_ALLOW_INSECURE_DB_TLS=true for an exceptional trusted-network deployment."
      );
    }
    ssl = false;
  } else if (["no-verify", "insecure", "require"].includes(requestedMode)) {
    if (!allowInsecure) {
      throw new Error(
        "DATABASE_SSL_MODE requests TLS without certificate verification. Set DATABASE_SSL_MODE=verify-full, or explicitly opt in with ATLAS_ALLOW_INSECURE_DB_TLS=true."
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
    throw new Error(`Unsupported DATABASE_SSL_MODE: ${requestedMode}`);
  }

  return {
    connectionString: sanitizeConnectionString(rawConnectionString),
    ssl
  };
}

function createDatabasePool() {
  return new Pool(createDatabaseConfig());
}

function getSessionSecret() {
  const configured = String(process.env.ATLAS_SESSION_SECRET || "").trim();
  const configuredBytes = Buffer.byteLength(configured, "utf8");

  if (configured && (!isProduction() || configuredBytes >= MIN_PRODUCTION_SECRET_BYTES)) {
    return configured;
  }

  if (isProduction()) {
    if (!configured) {
      throw new Error("ATLAS_SESSION_SECRET must be set in production.");
    }
    throw new Error(
      `ATLAS_SESSION_SECRET must be at least ${MIN_PRODUCTION_SECRET_BYTES} bytes in production.`
    );
  }

  const ephemeral = crypto.randomBytes(48).toString("base64url");
  console.warn(
    "⚠️ [AUTH] ATLAS_SESSION_SECRET is missing or too short. Using an ephemeral development-only secret; sessions will reset on restart."
  );
  return ephemeral;
}

function scrypt(password, salt, options = SCRYPT_PARAMS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  const value = String(password || "");
  if (!value) throw new Error("Password cannot be empty.");

  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(value, salt);
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
  const value = String(password || "");
  const encoded = String(storedHash || "").trim();

  if (encoded.startsWith("scrypt$")) {
    const parts = encoded.split("$");
    if (parts.length !== 6) return { valid: false, needsUpgrade: false };

    const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (![N, r, p].every(Number.isInteger)) return { valid: false, needsUpgrade: false };

    try {
      const expected = Buffer.from(hashB64, "base64");
      const actual = await scrypt(value, Buffer.from(saltB64, "base64"), {
        N,
        r,
        p,
        maxmem: 64 * 1024 * 1024
      });
      return { valid: timingSafeEqualBuffers(actual, expected), needsUpgrade: false };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  // Backward compatibility for existing installations. A successful login
  // against an old SHA-256 row is upgraded to scrypt immediately by server.js.
  if (/^[a-f0-9]{64}$/i.test(encoded)) {
    const actual = Buffer.from(crypto.createHash("sha256").update(value).digest("hex"), "hex");
    const expected = Buffer.from(encoded, "hex");
    const valid = timingSafeEqualBuffers(actual, expected);
    return { valid, needsUpgrade: valid };
  }

  return { valid: false, needsUpgrade: false };
}

async function initializeAuthStorage(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'view-only',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Repair the legacy role spelling used by the old seed path so existing
  // legitimate admins continue to receive write access.
  await pool.query(`
    UPDATE users
    SET role = 'admin'
    WHERE LOWER(role) IN ('full access', 'full-access', 'full_access')
  `);

  // Remove only accounts that still have the exact publicly-known defaults.
  // Custom passwords on accounts named admin/user are left untouched.
  for (const legacy of LEGACY_PUBLIC_DEFAULTS) {
    const removed = await pool.query(
      `DELETE FROM users
       WHERE LOWER(username) = LOWER($1)
         AND LOWER(password_hash) = LOWER($2)
       RETURNING id`,
      [legacy.username, legacy.hash]
    );
    if (removed.rowCount > 0) {
      console.warn(`⚠️ [AUTH] Removed insecure legacy default account: ${legacy.username}`);
    }
  }

  const adminCount = Number((await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"
  )).rows[0]?.count || 0);

  if (adminCount > 0) return;

  const username = String(process.env.ATLAS_BOOTSTRAP_ADMIN_USERNAME || "").trim();
  const password = String(process.env.ATLAS_BOOTSTRAP_ADMIN_PASSWORD || "");

  if (username && password) {
    if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
      throw new Error(
        `ATLAS_BOOTSTRAP_ADMIN_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters.`
      );
    }

    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = 'admin'`,
      [username, passwordHash]
    );
    console.log(`👤 [AUTH] Bootstrapped admin account from environment: ${username}`);
    return;
  }

  const message =
    "No admin account exists. Set ATLAS_BOOTSTRAP_ADMIN_USERNAME and ATLAS_BOOTSTRAP_ADMIN_PASSWORD to create the first admin.";

  if (isProduction()) throw new Error(message);
  console.warn(`⚠️ [AUTH] ${message}`);
}

module.exports = {
  createDatabaseConfig,
  createDatabasePool,
  getSessionSecret,
  hashPassword,
  verifyPassword,
  initializeAuthStorage,
  isProduction
};
