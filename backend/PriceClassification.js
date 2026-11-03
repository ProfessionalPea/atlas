/**
 * Play Store price classification.
 *
 * Four concepts are kept deliberately separate:
 *   - release_status        PRE_REGISTERED | LIVE
 *   - price_status          PRICE_TBA | PAID | FREE | UNKNOWN   (what Google Play verifiably tells us)
 *   - monetization_hint     LIKELY_PAID | NONE                  (developer text; never changes price_status)
 *   - manual_price_status   PAID | FREE | NULL                  (admin override; never overwritten by scans)
 *
 * Google Play returns the same placeholder offer ([[0, "<CUR>", ""]]) for free AND paid
 * pre-registration titles, so a zero price during pre-registration proves nothing.
 */

const PRICE_STATUS = Object.freeze({
  PRICE_TBA: 'PRICE_TBA',
  PAID: 'PAID',
  FREE: 'FREE',
  UNKNOWN: 'UNKNOWN'
});

const RELEASE_STATUS = Object.freeze({
  PRE_REGISTERED: 'PRE_REGISTERED',
  LIVE: 'LIVE'
});

const PRICE_SOURCE = Object.freeze({
  PLAY_STORE_PRICE: 'PLAY_STORE_PRICE',
  MANUAL: 'MANUAL',
  METADATA_HINT: 'METADATA_HINT',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Normalised offer input.
 *   preregister : true when Play lists the title as pre-registration
 *   offerMicros : price in micro-units (1.99 => 1990000); 0 = explicit zero offer;
 *                 null/undefined = no offer block at all
 *   currency    : ISO currency code from the offer block
 */
function normalizeOfferInput(input = {}) {
  const micros = Number(input.offerMicros);
  return {
    preregister: input.preregister === true,
    offerMicros: input.offerMicros == null || !Number.isFinite(micros) || micros < 0 ? null : micros,
    currency: typeof input.currency === 'string' && input.currency.trim() ? input.currency.trim().toUpperCase() : null,
    priceText: typeof input.priceText === 'string' && input.priceText.trim() ? input.priceText.trim() : null
  };
}

/** Adapter: google-play-scraper `gplay.app()` result. */
function offerFromGplayApp(app) {
  if (!app || typeof app !== 'object') return null;
  const price = Number(app.price);
  let offerMicros = null;
  if (Number.isFinite(price) && price > 0) offerMicros = Math.round(price * 1e6);
  // scraper sets free = (offerMicros === 0); a missing offer yields free=false, price=0
  else if (app.free === true) offerMicros = 0;
  return {
    preregister: app.preregister === true,
    offerMicros,
    currency: app.currency || null,
    priceText: app.priceText || null
  };
}

/** Adapter: parsed ds:5 payload from PlayStoreTelemetry.parsePlayStoreDs5Html. */
function offerFromDs5(ds5) {
  if (!ds5 || typeof ds5 !== 'object') return null;
  return {
    preregister: ds5.preregister === true,
    offerMicros: ds5.offerMicros ?? null,
    currency: ds5.offerCurrency || null,
    priceText: ds5.offerText || null
  };
}

// ---------------------------------------------------------------------------
// Monetization hint (developer-provided text only)
// ---------------------------------------------------------------------------

const FREE_GUARD = /\b(free[- ]to[- ]play|free[- ]to[- ]download|completely free|100\s?% free|download (it )?for free|play (it )?for free|totally free)\b/i;
const DISCOUNT_NEGATIVE_CONTEXT = /\b(ads?|advertis\w*|sponsor\w*|in-?app|in-?game|coins?|gems?|diamonds?|currency|shop|store items?|subscription|vip|battle pass|video|watch|other games?|our games?|skins?|packs?|bundles?)\b/i;
const LAUNCH_CONTEXT = /\b(launch|release|pre-?regist\w*|first\s+(?:\w+\s+)?(?:days?|weeks?|month)|opening|after\s+(?:the\s+)?launch)\b/i;
const PRICE_CONTEXT = /\b(launch|price|priced|buy|purchase|cost|costs|only)\b/i;

const HINT_RULES = [
  {
    id: 'launch_discount',
    re: /\b(launch|release|opening|introductory|early[- ]bird|pre-?order)\s+(discount|price|pricing|offer|sale)\b/i,
    discountRule: true
  },
  {
    id: 'percent_off_launch',
    re: /\b\d{1,2}\s?%\s*(?:off|discount)\b/i,
    need: LAUNCH_CONTEXT,
    discountRule: true
  },
  {
    id: 'pay_once',
    re: /\b(?:buy|pay|purchase)\s+(?:it\s+|the game\s+)?once\b|\bone[- ]time\s+(?:purchase|payment|fee|buy)\b|\bpay[- ]once\b/i
  },
  {
    id: 'premium_title',
    re: /\bpremium\s+(?:game|adventure|experience|title|version|edition)\b/i
  },
  {
    id: 'paid_game',
    re: /\bpaid\s+(?:game|app|title|version)\b/i
  },
  {
    id: 'price_mention',
    re: /(?:US\$|\$|€|£|Rs\.?|PKR|USD|EUR|GBP|INR)\s?\d+(?:[.,]\d{1,2})?/i,
    need: PRICE_CONTEXT,
    discountRule: true
  }
];

function cleanText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|\s*[\r\n]+\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/**
 * Returns { hint: 'LIKELY_PAID'|'NONE', evidence: string|null, rule: string|null }.
 * Matching is done per sentence so a discount mentioned for ads / in-game items / other games
 * is not mistaken for a paid-game signal.
 */
function detectMonetizationHint(...texts) {
  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      if (FREE_GUARD.test(sentence)) continue;
      for (const rule of HINT_RULES) {
        if (!rule.re.test(sentence)) continue;
        if (rule.need && !rule.need.test(sentence)) continue;
        if (rule.discountRule && DISCOUNT_NEGATIVE_CONTEXT.test(sentence)) continue;
        return {
          hint: 'LIKELY_PAID',
          evidence: sentence.length > 260 ? `${sentence.slice(0, 257)}...` : sentence,
          rule: rule.id
        };
      }
    }
  }
  return { hint: 'NONE', evidence: null, rule: null };
}

// ---------------------------------------------------------------------------
// Core classification (pure)
// ---------------------------------------------------------------------------

/**
 * @param {object} offerInput  see normalizeOfferInput
 * @param {string[]} texts     developer-provided text (description, short description)
 */
function classifyPlayPrice(offerInput, texts = []) {
  const offer = normalizeOfferInput(offerInput || {});
  const release_status = offer.preregister ? RELEASE_STATUS.PRE_REGISTERED : RELEASE_STATUS.LIVE;

  let price_status;
  let price = null;
  let currency = null;
  let price_text = null;

  if (offer.offerMicros != null && offer.offerMicros > 0) {
    // A real, positive offer is valid evidence of a paid game, before or after launch.
    price_status = PRICE_STATUS.PAID;
    price = offer.offerMicros / 1e6;
    currency = offer.currency || null;
    price_text = offer.priceText || null;
  } else if (offer.preregister) {
    // Zero / empty / missing offers are placeholders during pre-registration.
    price_status = PRICE_STATUS.PRICE_TBA;
  } else if (offer.offerMicros === 0 && offer.currency) {
    // Live title with an explicit zero offer in a real currency.
    price_status = PRICE_STATUS.FREE;
    price_text = 'Free';
  } else {
    // Live but no explicit offer (missing / ambiguous) -> never guess.
    price_status = PRICE_STATUS.UNKNOWN;
  }

  const price_source =
    price_status === PRICE_STATUS.PAID || price_status === PRICE_STATUS.FREE
      ? PRICE_SOURCE.PLAY_STORE_PRICE
      : PRICE_SOURCE.UNKNOWN;

  let hint = { hint: 'NONE', evidence: null, rule: null };
  if (price_status === PRICE_STATUS.PRICE_TBA || price_status === PRICE_STATUS.UNKNOWN) {
    hint = detectMonetizationHint(...(Array.isArray(texts) ? texts : [texts]));
  }

  return {
    release_status,
    price_status,
    price_source,
    price,
    currency,
    price_text,
    monetization_hint: hint.hint,
    monetization_hint_evidence: hint.evidence,
    monetization_hint_rule: hint.rule,
    observed_currency: offer.currency
  };
}

/**
 * Effective status for display / filtering / counts.
 * Play-verified PAID/FREE always wins (the override is retained and flagged when it disagrees);
 * otherwise a manual override applies; otherwise the automatic status.
 */
function resolveEffectivePricing(row = {}) {
  const auto = row.price_status || null;
  const manual = row.manual_price_status || null;
  const verified = auto === PRICE_STATUS.PAID || auto === PRICE_STATUS.FREE;

  let effective;
  let source;
  if (verified) {
    effective = auto;
    source = PRICE_SOURCE.PLAY_STORE_PRICE;
  } else if (manual) {
    effective = manual;
    source = PRICE_SOURCE.MANUAL;
  } else {
    effective = auto || PRICE_STATUS.UNKNOWN;
    source = auto ? row.price_source || PRICE_SOURCE.UNKNOWN : PRICE_SOURCE.UNKNOWN;
  }

  const pricing =
    effective === PRICE_STATUS.PAID ? 'paid'
    : effective === PRICE_STATUS.FREE ? 'free'
    : effective === PRICE_STATUS.PRICE_TBA ? 'tba'
    : 'unknown';

  return {
    effective_price_status: effective,
    classification_source: source,
    pricing,
    is_manual: source === PRICE_SOURCE.MANUAL,
    override_conflict: Boolean(manual) && verified && manual !== auto
  };
}

/** SQL expression (string) for the effective price status of games alias `a`. */
function effectiveStatusSql(a = 'g') {
  return `(CASE
    WHEN ${a}.price_status IN ('PAID','FREE') THEN ${a}.price_status
    WHEN ${a}.manual_price_status IS NOT NULL THEN ${a}.manual_price_status
    ELSE COALESCE(${a}.price_status, 'UNKNOWN')
  END)`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function initializePriceClassificationStorage(pool) {
  await pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS campaign_active BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS first_campaign_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_campaign_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS campaign_source VARCHAR(64) DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS release_status TEXT,
      ADD COLUMN IF NOT EXISTS price_status TEXT,
      ADD COLUMN IF NOT EXISTS price_source TEXT,
      ADD COLUMN IF NOT EXISTS price_observed_currency TEXT,
      ADD COLUMN IF NOT EXISTS price_classified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS monetization_hint TEXT,
      ADD COLUMN IF NOT EXISTS monetization_hint_evidence TEXT,
      ADD COLUMN IF NOT EXISTS monetization_hint_rule TEXT,
      ADD COLUMN IF NOT EXISTS prereg_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS went_live_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS manual_price_status TEXT,
      ADD COLUMN IF NOT EXISTS manual_price_note TEXT,
      ADD COLUMN IF NOT EXISTS manual_price_by TEXT,
      ADD COLUMN IF NOT EXISTS manual_price_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS game_price_history (
      id BIGSERIAL PRIMARY KEY,
      package_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_release_status TEXT,
      to_release_status TEXT,
      from_price_status TEXT,
      to_price_status TEXT,
      price NUMERIC(12,4),
      currency TEXT,
      source TEXT,
      actor TEXT,
      note TEXT,
      evidence JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_game_price_history_pkg ON game_price_history(package_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_games_price_status ON games(price_status);
  `);
}

/**
 * Classify a game from fresh Play Store data and persist the result.
 * Never touches manual_price_* columns. Records history on release/price transitions.
 * Returns the classification, or null if the game row does not exist / input is unusable.
 */
async function applyPriceClassification(pool, packageName, offerInput, texts = [], options = {}) {
  if (!packageName || !offerInput) return null;
  const cur = await pool.query(
    `SELECT id, release_status, price_status, price, currency
     FROM games WHERE package_name = $1 LIMIT 1`,
    [packageName]
  );
  const prev = cur.rows[0];
  if (!prev) return null;

  const cls = classifyPlayPrice(offerInput, texts);

  await pool.query(
    `UPDATE games
     SET release_status = $2,
         price_status = $3,
         price_source = $4,
         price_observed_currency = $5,
         price_classified_at = now(),
         monetization_hint = $6,
         monetization_hint_evidence = $7,
         monetization_hint_rule = $8,
         is_paid = $9,
         price = $10,
         currency = $11,
         price_text = $12,
         prereg_seen_at = CASE
           WHEN $2 = 'PRE_REGISTERED' THEN COALESCE(prereg_seen_at, now())
           ELSE prereg_seen_at
         END,
         went_live_at = CASE
           WHEN $2 = 'LIVE' AND release_status = 'PRE_REGISTERED' THEN now()
           ELSE went_live_at
         END
     WHERE id = $1`,
    [
      prev.id,
      cls.release_status,
      cls.price_status,
      cls.price_source,
      cls.observed_currency,
      cls.monetization_hint,
      cls.monetization_hint_evidence,
      cls.monetization_hint_rule,
      cls.price_status === PRICE_STATUS.PAID,
      cls.price_status === PRICE_STATUS.PAID ? cls.price : null,
      cls.price_status === PRICE_STATUS.PAID ? cls.currency || 'USD' : null,
      cls.price_text
    ]
  );

  const launched = prev.release_status === RELEASE_STATUS.PRE_REGISTERED && cls.release_status === RELEASE_STATUS.LIVE;
  const firstClassification = !prev.price_status && !prev.release_status;
  const changed =
    prev.price_status !== cls.price_status || prev.release_status !== cls.release_status;

  if (launched || (changed && !firstClassification) || (firstClassification && options.recordInitial)) {
    await pool.query(
      `INSERT INTO game_price_history
         (package_name, event_type, from_release_status, to_release_status,
          from_price_status, to_price_status, price, currency, source, actor, note, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        packageName,
        launched ? 'LAUNCHED' : firstClassification ? 'INITIAL' : 'RECLASSIFIED',
        prev.release_status || null,
        cls.release_status,
        prev.price_status || null,
        cls.price_status,
        cls.price,
        cls.currency,
        options.source || 'scan',
        null,
        options.note || null,
        JSON.stringify({
          offer: normalizeOfferInput(offerInput),
          hint: cls.monetization_hint,
          hint_evidence: cls.monetization_hint_evidence
        })
      ]
    );
  }

  return cls;
}

/** Recompute stored per-publisher free/paid counts using the effective status. */
async function recomputePublisherPriceCounts(pool, publisherId = null) {
  const eff = effectiveStatusSql('g');
  await pool.query(
    `UPDATE play_publishers p
     SET free_games = COALESCE(sub.free_cnt, 0),
         paid_games = COALESCE(sub.paid_cnt, 0)
     FROM (
       SELECT pp.id AS pub_id,
              COUNT(DISTINCT g.id) FILTER (WHERE ${eff} = 'FREE')::int AS free_cnt,
              COUNT(DISTINCT g.id) FILTER (WHERE ${eff} = 'PAID')::int AS paid_cnt
       FROM play_publishers pp
       LEFT JOIN account_games ag ON ag.account_id = pp.id
       LEFT JOIN games g ON g.id = ag.game_id AND COALESCE(g.is_suspended, false) = false
       WHERE ($1::int IS NULL OR pp.id = $1::int)
       GROUP BY pp.id
     ) sub
     WHERE p.id = sub.pub_id`,
    [publisherId]
  );
}

/**
 * Admin manual override. status: 'PAID' | 'FREE' | 'CLEAR'.
 * The override is stored beside (never instead of) the automatic Play Store classification.
 */
async function setManualPriceOverride(pool, packageName, { status, note = null, actor = null } = {}) {
  const wanted = String(status || '').toUpperCase();
  if (!['PAID', 'FREE', 'CLEAR'].includes(wanted)) {
    const err = new Error('status must be PAID, FREE or CLEAR');
    err.statusCode = 400;
    throw err;
  }
  const cur = await pool.query(
    `SELECT id, price_status, release_status, manual_price_status FROM games WHERE package_name = $1 LIMIT 1`,
    [packageName]
  );
  const game = cur.rows[0];
  if (!game) {
    const err = new Error('Game not found');
    err.statusCode = 404;
    throw err;
  }

  const cleanNote = note ? String(note).trim().slice(0, 500) : null;
  if (wanted === 'CLEAR') {
    await pool.query(
      `UPDATE games
       SET manual_price_status = NULL, manual_price_note = NULL, manual_price_by = NULL, manual_price_at = NULL
       WHERE id = $1`,
      [game.id]
    );
  } else {
    await pool.query(
      `UPDATE games
       SET manual_price_status = $2, manual_price_note = $3, manual_price_by = $4, manual_price_at = now()
       WHERE id = $1`,
      [game.id, wanted, cleanNote, actor]
    );
  }

  await pool.query(
    `INSERT INTO game_price_history
       (package_name, event_type, from_release_status, to_release_status,
        from_price_status, to_price_status, source, actor, note)
     VALUES ($1,$2,$3,$3,$4,$5,'MANUAL',$6,$7)`,
    [
      packageName,
      wanted === 'CLEAR' ? 'MANUAL_CLEARED' : 'MANUAL_SET',
      game.release_status || null,
      game.manual_price_status || game.price_status || null,
      wanted === 'CLEAR' ? game.price_status || null : wanted,
      actor,
      cleanNote
    ]
  );

  await recomputePublisherPriceCounts(pool);
  return { packageName, manual_price_status: wanted === 'CLEAR' ? null : wanted };
}

module.exports = {
  PRICE_STATUS,
  RELEASE_STATUS,
  PRICE_SOURCE,
  normalizeOfferInput,
  offerFromGplayApp,
  offerFromDs5,
  detectMonetizationHint,
  classifyPlayPrice,
  resolveEffectivePricing,
  effectiveStatusSql,
  initializePriceClassificationStorage,
  applyPriceClassification,
  recomputePublisherPriceCounts,
  setManualPriceOverride
};
