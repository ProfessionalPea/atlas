const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  createDatabaseConfig,
  getSessionSecret,
  hashPassword,
  verifyPassword
} = require("./Security");

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "DATABASE_SSL_MODE",
  "DATABASE_CA_CERT",
  "ATLAS_ALLOW_INSECURE_DB_TLS",
  "ATLAS_SESSION_SECRET",
  "FRONTEND_URL",
  "ADDITIONAL_ALLOWED_ORIGINS",
  "ATLAS_BOOTSTRAP_ADMIN_USERNAME",
  "ATLAS_BOOTSTRAP_ADMIN_PASSWORD"
];

function withEnvironment(overrides, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];

  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }

  const restore = () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("passwords use salted scrypt and verify without accepting a wrong password", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.deepEqual(await verifyPassword("correct horse battery staple", first), {
    valid: true,
    needsUpgrade: false
  });
  assert.deepEqual(await verifyPassword("wrong password", first), {
    valid: false,
    needsUpgrade: false
  });
});

test("malformed or out-of-policy scrypt parameters fail closed", async () => {
  assert.deepEqual(await verifyPassword("password", "scrypt$99999999$8$1$YQ==$YQ=="), {
    valid: false,
    needsUpgrade: false
  });
  assert.deepEqual(await verifyPassword("password", "scrypt$16384$8$1$YQ==$YQ=="), {
    valid: false,
    needsUpgrade: false
  });
});

test("legacy SHA-256 rows remain login-compatible and request an upgrade", async () => {
  const password = "a unique pre-hardening password";
  const legacyHash = crypto.createHash("sha256").update(password).digest("hex");

  assert.deepEqual(await verifyPassword(password, legacyHash), {
    valid: true,
    needsUpgrade: true
  });
  assert.deepEqual(await verifyPassword("not that password", legacyHash), {
    valid: false,
    needsUpgrade: false
  });
});

test("production requires a configured session secret of at least 32 bytes", () => {
  withEnvironment({ NODE_ENV: "production" }, () => {
    assert.throws(() => getSessionSecret(), /must be set in production/i);
  });

  withEnvironment({ NODE_ENV: "production", ATLAS_SESSION_SECRET: "too-short" }, () => {
    assert.throws(() => getSessionSecret(), /at least 32 bytes/i);
  });

  const strong = "0123456789abcdef0123456789abcdef";
  withEnvironment({ NODE_ENV: "production", ATLAS_SESSION_SECRET: strong }, () => {
    assert.equal(getSessionSecret(), strong);
  });
});

test("development receives a random session secret instead of a known fallback", () => {
  withEnvironment({ NODE_ENV: "development" }, () => {
    const first = getSessionSecret();
    const second = getSessionSecret();
    assert.ok(Buffer.byteLength(first, "utf8") >= 32);
    assert.notEqual(first, second);
  });
});

test("remote database connections verify TLS even if DATABASE_URL includes sslmode=require", () => {
  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas?sslmode=require"
  }, () => {
    const config = createDatabaseConfig();
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.doesNotMatch(config.connectionString, /sslmode=/i);
  });
});

test("a private CA certificate is normalized and passed to PostgreSQL", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----";
  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas",
    DATABASE_CA_CERT: ca.replace(/\n/g, "\\n")
  }, () => {
    const config = createDatabaseConfig();
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl.ca, ca);
  });
});

test("localhost can use plaintext, but remote plaintext requires explicit opt-in", () => {
  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/atlas"
  }, () => {
    assert.equal(createDatabaseConfig().ssl, false);
  });

  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas",
    DATABASE_SSL_MODE: "disable"
  }, () => {
    assert.throws(() => createDatabaseConfig(), /Refusing an unencrypted remote database connection/i);
  });

  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas",
    DATABASE_SSL_MODE: "disable",
    ATLAS_ALLOW_INSECURE_DB_TLS: "true"
  }, () => {
    assert.equal(createDatabaseConfig().ssl, false);
  });
});

test("TLS without certificate verification requires explicit opt-in", () => {
  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas",
    DATABASE_SSL_MODE: "require"
  }, () => {
    assert.throws(() => createDatabaseConfig(), /without certificate verification/i);
  });

  withEnvironment({
    DATABASE_URL: "postgresql://user:pass@db.example.com:5432/atlas",
    DATABASE_SSL_MODE: "require",
    ATLAS_ALLOW_INSECURE_DB_TLS: "true"
  }, () => {
    assert.equal(createDatabaseConfig().ssl.rejectUnauthorized, false);
  });
});
