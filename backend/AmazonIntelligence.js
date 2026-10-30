const fs = require('fs');
const path = require('path');
const {
  validateAmazonUrl,
  validateBatch,
  computeStats,
  scanPublishers
} = require('./AmazonScanner');

let amazonScanStatus = {
  running: false,
  state: 'idle',
  phase: 'idle',
  isCancelled: false,
  isComplete: false,
  isError: false,
  currentPublisher: null,
  publisherIndex: 0,
  completedPublishers: 0,
  totalPublishers: 0,
  currentPage: 0,
  totalPagesProcessed: 0,
  gamesFoundInCurrent: 0,
  totalGamesSaved: 0,
  startedAt: null,
  finishedAt: null,
  resultsSummary: [],
  failedLinks: [],
  log: '> Ready to scan Amazon Appstore publishers.'
};
let activeAmazonScanCancelled = false;

function normalizePublisherKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function savePublisherScanResult(pool, r) {
  if (!r || !r.publisher) return null;
  const stats = r.stats || computeStats(r.games || []);
  const normName = normalizePublisherKey(r.publisher);
  const host = r.host || 'www.amazon.com';
  const currency = (stats.currencies && stats.currencies[0]) || '$';

  // If the scan failed/blocked with 0 games, only record status if publisher already exists;
  // do not overwrite existing game counts or last_successful_scan_at with zeros.
  const existingPubRes = await pool.query(
    `SELECT id, total_games FROM amazon_publishers WHERE host = $1 AND normalized_name = $2 LIMIT 1`,
    [host, normName]
  );
  const existingPub = existingPubRes.rows[0] || null;

  if ((!r.games || r.games.length === 0) && existingPub && existingPub.total_games > 0) {
    await pool.query(
      `UPDATE amazon_publishers
       SET last_scan_status = $2,
           last_scan_detail = $3,
           last_scanned_at = now()
       WHERE id = $1`,
      [existingPub.id, r.status || 'error', r.statusDetail || null]
    );
    await pool.query(
      `INSERT INTO amazon_scan_snapshots (
         publisher_id, publisher_name, status, status_detail, pages_read, reported_total,
         total_games, free_games, paid_games, unknown_games
       ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0)`,
      [existingPub.id, r.publisher, r.status || 'error', r.statusDetail || null, r.pagesRead || 0, r.reportedTotal ?? null]
    );
    return existingPub.id;
  }

  const hasSuccessfulGames = (stats.total || 0) > 0 || r.status === 'complete' || r.status === 'partial';

  const pubUpsert = await pool.query(
    `INSERT INTO amazon_publishers (
       publisher_name, normalized_name, host, source_url,
       total_games, free_games, paid_games, unknown_games,
       free_share, free_to_paid_ratio, avg_paid_price, median_paid_price, currency,
       avg_rating, total_reviews, free_review_share,
       last_scan_status, last_scan_detail, last_scanned_at, last_successful_scan_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, $16,
       $17, $18, now(), CASE WHEN $19::boolean THEN now() ELSE NULL END
     )
     ON CONFLICT (host, normalized_name) DO UPDATE SET
       publisher_name = EXCLUDED.publisher_name,
       source_url = EXCLUDED.source_url,
       total_games = EXCLUDED.total_games,
       free_games = EXCLUDED.free_games,
       paid_games = EXCLUDED.paid_games,
       unknown_games = EXCLUDED.unknown_games,
       free_share = EXCLUDED.free_share,
       free_to_paid_ratio = EXCLUDED.free_to_paid_ratio,
       avg_paid_price = EXCLUDED.avg_paid_price,
       median_paid_price = EXCLUDED.median_paid_price,
       currency = EXCLUDED.currency,
       avg_rating = EXCLUDED.avg_rating,
       total_reviews = EXCLUDED.total_reviews,
       free_review_share = EXCLUDED.free_review_share,
       last_scan_status = EXCLUDED.last_scan_status,
       last_scan_detail = EXCLUDED.last_scan_detail,
       last_scanned_at = now(),
       last_successful_scan_at = CASE
         WHEN $19::boolean THEN now()
         ELSE amazon_publishers.last_successful_scan_at
       END
     RETURNING id`,
    [
      r.publisher,
      normName,
      host,
      r.sourceUrl || `https://${host}/s?i=mobile-apps&rh=p_4%3A${encodeURIComponent(r.publisher).replace(/%20/g, '%2B')}&search-type=ss`,
      stats.total || 0,
      stats.free || 0,
      stats.paid || 0,
      stats.unknown || 0,
      stats.freeShare ?? null,
      stats.freeToPaidRatio ?? null,
      stats.avgPaidPrice ?? null,
      stats.medianPaidPrice ?? null,
      currency,
      stats.avgRating ?? null,
      stats.totalReviews || 0,
      stats.freeReviewShare ?? null,
      r.status || 'complete',
      r.statusDetail || null,
      hasSuccessfulGames
    ]
  );
  const publisherId = pubUpsert.rows[0].id;

  // Fetch previous games for diff calculation
  const prevGamesRes = await pool.query(
    `SELECT asin, pricing, price FROM amazon_games WHERE publisher_id = $1`,
    [publisherId]
  );
  const prevByAsin = new Map(prevGamesRes.rows.map((g) => [g.asin, g]));
  const currentAsins = new Set();
  const addedAsins = [];
  const pricingChanges = [];

  const validGames = (r.games || []).filter((g) => g && g.asin);
  for (const g of validGames) {
    currentAsins.add(g.asin);
    const prev = prevByAsin.get(g.asin);
    if (!prev && prevByAsin.size > 0) {
      addedAsins.push(g.asin);
    } else if (prev && (prev.pricing !== g.pricing || Number(prev.price || 0) !== Number(g.price || 0))) {
      pricingChanges.push({
        asin: g.asin,
        title: g.title,
        fromPricing: prev.pricing,
        toPricing: g.pricing,
        fromPrice: prev.price,
        toPrice: g.price
      });
    }
  }

  if (validGames.length > 0) {
    await pool.query(
      `INSERT INTO amazon_games (
         asin, publisher_id, publisher_name, title, url, icon,
         price_text, price, currency, pricing,
         rating, review_count, review_count_approx, release_date,
         first_seen_at, last_seen_at
       )
       SELECT
         u.asin,
         $1::int,
         $2::text,
         u.title,
         u.url,
         u.icon,
         u.price_text,
         u.price,
         u.currency,
         u.pricing,
         u.rating,
         u.review_count,
         u.review_count_approx,
         u.release_date::date,
         now(),
         now()
       FROM unnest(
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::double precision[],
         $9::text[],
         $10::text[],
         $11::double precision[],
         $12::int[],
         $13::boolean[],
         $14::text[]
       ) AS u(
         asin, title, url, icon, price_text, price, currency, pricing,
         rating, review_count, review_count_approx, release_date
       )
       ON CONFLICT (asin, publisher_id) DO UPDATE SET
         publisher_name = EXCLUDED.publisher_name,
         title = EXCLUDED.title,
         url = EXCLUDED.url,
         icon = COALESCE(EXCLUDED.icon, amazon_games.icon),
         price_text = EXCLUDED.price_text,
         price = EXCLUDED.price,
         currency = EXCLUDED.currency,
         pricing = EXCLUDED.pricing,
         rating = EXCLUDED.rating,
         review_count = EXCLUDED.review_count,
         review_count_approx = EXCLUDED.review_count_approx,
         release_date = COALESCE(EXCLUDED.release_date, amazon_games.release_date),
         last_seen_at = now()`,
      [
        publisherId,
        r.publisher,
        validGames.map((g) => g.asin),
        validGames.map((g) => g.title || g.asin),
        validGames.map((g) => g.url || `https://${host}/dp/${g.asin}`),
        validGames.map((g) => g.icon || null),
        validGames.map((g) => g.priceText || null),
        validGames.map((g) => (g.price !== undefined && g.price !== null ? Number(g.price) : null)),
        validGames.map((g) => g.currency || currency),
        validGames.map((g) => g.pricing || 'unknown'),
        validGames.map((g) => (g.rating !== undefined && g.rating !== null ? Number(g.rating) : null)),
        validGames.map((g) => (g.reviewCount !== undefined && g.reviewCount !== null ? Number(g.reviewCount) : null)),
        validGames.map((g) => Boolean(g.reviewCountApprox)),
        validGames.map((g) => g.releaseDate || null)
      ]
    );
  }

  const removedAsins = r.status === 'complete'
    ? [...prevByAsin.keys()].filter((asin) => !currentAsins.has(asin))
    : [];

  await pool.query(
    `INSERT INTO amazon_scan_snapshots (
       publisher_id, publisher_name, status, status_detail, pages_read, reported_total,
       total_games, free_games, paid_games, unknown_games,
       median_paid_price, avg_rating, total_reviews,
       added_asins, removed_asins, pricing_changes
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13,
       $14::jsonb, $15::jsonb, $16::jsonb
     )`,
    [
      publisherId,
      r.publisher,
      r.status || 'complete',
      r.statusDetail || null,
      r.pagesRead || 0,
      r.reportedTotal ?? null,
      stats.total || 0,
      stats.free || 0,
      stats.paid || 0,
      stats.unknown || 0,
      stats.medianPaidPrice ?? null,
      stats.avgRating ?? null,
      stats.totalReviews || 0,
      JSON.stringify(addedAsins),
      JSON.stringify(removedAsins),
      JSON.stringify(pricingChanges)
    ]
  );

  return publisherId;
}

async function initializeAmazonStorage(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS amazon_publishers (
      id SERIAL PRIMARY KEY,
      publisher_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT 'www.amazon.com',
      source_url TEXT NOT NULL,
      total_games INTEGER NOT NULL DEFAULT 0,
      free_games INTEGER NOT NULL DEFAULT 0,
      paid_games INTEGER NOT NULL DEFAULT 0,
      unknown_games INTEGER NOT NULL DEFAULT 0,
      free_share DOUBLE PRECISION,
      free_to_paid_ratio DOUBLE PRECISION,
      avg_paid_price DOUBLE PRECISION,
      median_paid_price DOUBLE PRECISION,
      currency TEXT DEFAULT '$',
      avg_rating DOUBLE PRECISION,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      free_review_share DOUBLE PRECISION,
      last_scan_status TEXT DEFAULT 'unscanned',
      last_scan_detail TEXT,
      last_scanned_at TIMESTAMPTZ DEFAULT now(),
      display_name TEXT,
      UNIQUE (host, normalized_name)
    );

    ALTER TABLE amazon_publishers ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE amazon_publishers ADD COLUMN IF NOT EXISTS last_successful_scan_at TIMESTAMPTZ;

    UPDATE amazon_publishers p
    SET last_successful_scan_at = COALESCE(
      (SELECT MAX(s.scanned_at) FROM amazon_scan_snapshots s WHERE s.publisher_id = p.id AND (s.status = 'complete' OR s.total_games > 0)),
      (SELECT MAX(g.last_seen_at) FROM amazon_games g WHERE g.publisher_id = p.id),
      p.last_scanned_at
    )
    WHERE p.last_successful_scan_at IS NULL AND p.total_games > 0;

    CREATE TABLE IF NOT EXISTS amazon_lists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS amazon_list_publishers (
      list_id INTEGER NOT NULL REFERENCES amazon_lists(id) ON DELETE CASCADE,
      publisher_id INTEGER NOT NULL REFERENCES amazon_publishers(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (list_id, publisher_id)
    );

    CREATE INDEX IF NOT EXISTS idx_amazon_list_publishers_pub ON amazon_list_publishers(publisher_id);

    CREATE TABLE IF NOT EXISTS amazon_games (
      asin TEXT NOT NULL,
      publisher_id INTEGER NOT NULL REFERENCES amazon_publishers(id) ON DELETE CASCADE,
      publisher_name TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT,
      price_text TEXT,
      price DOUBLE PRECISION,
      currency TEXT DEFAULT '$',
      pricing TEXT NOT NULL DEFAULT 'unknown',
      rating DOUBLE PRECISION,
      review_count INTEGER,
      review_count_approx BOOLEAN DEFAULT false,
      release_date DATE,
      first_seen_at TIMESTAMPTZ DEFAULT now(),
      last_seen_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (asin, publisher_id)
    );

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'amazon_games' AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.constraint_name HAVING COUNT(*) = 1
      ) THEN
        ALTER TABLE amazon_games DROP CONSTRAINT amazon_games_pkey;
        ALTER TABLE amazon_games ADD PRIMARY KEY (asin, publisher_id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_amazon_games_publisher_id ON amazon_games(publisher_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_games_pricing ON amazon_games(pricing);
    CREATE INDEX IF NOT EXISTS idx_amazon_games_asin ON amazon_games(asin);

    CREATE TABLE IF NOT EXISTS amazon_scan_snapshots (
      id SERIAL PRIMARY KEY,
      publisher_id INTEGER REFERENCES amazon_publishers(id) ON DELETE CASCADE,
      publisher_name TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      pages_read INTEGER NOT NULL DEFAULT 0,
      reported_total INTEGER,
      total_games INTEGER NOT NULL DEFAULT 0,
      free_games INTEGER NOT NULL DEFAULT 0,
      paid_games INTEGER NOT NULL DEFAULT 0,
      unknown_games INTEGER NOT NULL DEFAULT 0,
      median_paid_price DOUBLE PRECISION,
      avg_rating DOUBLE PRECISION,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      added_asins JSONB DEFAULT '[]'::jsonb,
      removed_asins JSONB DEFAULT '[]'::jsonb,
      pricing_changes JSONB DEFAULT '[]'::jsonb,
      scanned_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Seed from PoC output if table has fewer than 16 publishers
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM amazon_publishers`);
  if ((rows[0]?.cnt || 0) < 16) {
    const pocPath = path.join(__dirname, 'scripts', 'amazon-poc-output.json');
    if (fs.existsSync(pocPath)) {
      try {
        const poc = JSON.parse(fs.readFileSync(pocPath, 'utf8'));
        if (Array.isArray(poc.results)) {
          for (const r of poc.results) {
            await savePublisherScanResult(pool, r);
          }
          console.log(`📦 [Amazon Intelligence] Seeded ${poc.results.length} Amazon publishers into PostgreSQL.`);
        }
      } catch (err) {
        console.warn('⚠️ [Amazon Intelligence] Failed to seed from amazon-poc-output.json:', err.message);
      }
    }
  }

  // Seed default list containing existing publishers if no lists exist yet
  const { rows: listRows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM amazon_lists`);
  if ((listRows[0]?.cnt || 0) === 0) {
    const { rows: allPubs } = await pool.query(`SELECT id FROM amazon_publishers ORDER BY id ASC`);
    if (allPubs.length > 0) {
      const listRes = await pool.query(
        `INSERT INTO amazon_lists (name, description) VALUES ($1, $2) RETURNING id`,
        ['Initial 16 Amazon Accounts', 'Default competitor group seeded from initial 16 Amazon Appstore accounts']
      );
      const defaultListId = listRes.rows[0].id;
      await pool.query(
        `INSERT INTO amazon_list_publishers (list_id, publisher_id)
         SELECT $1::int, unnest($2::int[])
         ON CONFLICT DO NOTHING`,
        [defaultListId, allPubs.map((p) => p.id)]
      );
    }
  }
}

function parseInputLinks(raw) {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => String(item || '').split(/[\r\n]+/)).map((s) => s.trim()).filter(Boolean);
  }
  return String(raw || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

// In-memory TTL cache for /api/amazon/overview so repeated tab switches and page reloads respond in <5ms
let amazonOverviewCache = { payload: null, expiresAt: 0 };
function invalidateAmazonOverviewCache() {
  amazonOverviewCache = { payload: null, expiresAt: 0 };
}

function registerAmazonRoutes({ app, pool }) {
  // Invalidate overview cache automatically whenever any Amazon mutation runs
  app.use('/api/amazon', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      res.on('finish', () => invalidateAmazonOverviewCache());
    }
    next();
  });

  app.post('/api/amazon/validate', (req, res) => {
    const links = parseInputLinks(req.body?.links || req.body?.urls || '');
    const validation = validateBatch(links);
    const validCount = validation.filter((v) => v.valid && !v.duplicate).length;
    const duplicateCount = validation.filter((v) => v.duplicate).length;
    const invalidCount = validation.filter((v) => !v.valid).length;
    res.json({
      totalSubmitted: validation.length,
      validCount,
      duplicateCount,
      invalidCount,
      validation
    });
  });

  app.get('/api/amazon/overview', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const forceFresh = req.query?.fresh === '1';
      if (!forceFresh && amazonOverviewCache.payload && amazonOverviewCache.expiresAt > Date.now()) {
        return res.json(amazonOverviewCache.payload);
      }

      const [pubsRes, gamesRes, snapsRes, listsRes, membershipsRes] = await Promise.all([
        pool.query(`
          SELECT *
          FROM amazon_publishers
          ORDER BY total_games DESC, publisher_name ASC
        `),
        pool.query(`
          SELECT *
          FROM amazon_games
          ORDER BY COALESCE(review_count, 0) DESC, COALESCE(price, 0) DESC, title ASC
        `),
        pool.query(`
          SELECT *
          FROM amazon_scan_snapshots
          ORDER BY scanned_at DESC
          LIMIT 50
        `),
        pool.query(`
          SELECT *
          FROM amazon_lists
          ORDER BY id ASC
        `),
        pool.query(`
          SELECT list_id, publisher_id
          FROM amazon_list_publishers
        `)
      ]);

      const listsById = new Map(listsRes.rows.map((l) => [l.id, { ...l, publisher_ids: [] }]));
      const listIdsByPub = new Map();

      for (const m of membershipsRes.rows) {
        if (listsById.has(m.list_id)) {
          listsById.get(m.list_id).publisher_ids.push(m.publisher_id);
        }
        if (!listIdsByPub.has(m.publisher_id)) listIdsByPub.set(m.publisher_id, []);
        listIdsByPub.get(m.publisher_id).push(m.list_id);
      }

      const publishers = pubsRes.rows.map((p) => {
        const lIds = listIdsByPub.get(p.id) || [];
        return {
          ...p,
          effective_name: (p.display_name && p.display_name.trim()) ? p.display_name.trim() : p.publisher_name,
          list_ids: lIds
        };
      });

      const pubById = new Map(publishers.map((p) => [p.id, p]));

      // Track shared ASINs across publishers for honest unique-game vs. total-listing counts
      const publishersByAsin = new Map();
      const gamesByPubId = new Map();
      for (const g of gamesRes.rows) {
        if (!publishersByAsin.has(g.asin)) publishersByAsin.set(g.asin, []);
        const pubList = publishersByAsin.get(g.asin);
        if (!pubList.includes(g.publisher_name)) pubList.push(g.publisher_name);

        if (!gamesByPubId.has(g.publisher_id)) gamesByPubId.set(g.publisher_id, []);
        gamesByPubId.get(g.publisher_id).push(g);
      }

      const games = gamesRes.rows.map((g) => {
        const sharedPubs = publishersByAsin.get(g.asin) || [g.publisher_name];
        return {
          ...g,
          shared_publisher_count: sharedPubs.length,
          shared_publishers: sharedPubs
        };
      });

      const lists = [...listsById.values()].map((l) => {
        const memberPubs = l.publisher_ids.map((id) => pubById.get(id)).filter(Boolean);
        const totalListings = memberPubs.reduce((s, p) => s + (Number(p.total_games) || 0), 0);
        const seenAsins = new Map();
        for (const pubId of l.publisher_ids) {
          const pGames = gamesByPubId.get(pubId) || [];
          for (const g of pGames) {
            if (!seenAsins.has(g.asin)) seenAsins.set(g.asin, g);
          }
        }
        const uniqueListGames = [...seenAsins.values()];
        const uniqueGamesCount = uniqueListGames.length || totalListings;
        const uniqueFree = uniqueListGames.length
          ? uniqueListGames.filter((g) => g.pricing === 'free').length
          : memberPubs.reduce((s, p) => s + (Number(p.free_games) || 0), 0);
        const uniquePaid = uniqueListGames.length
          ? uniqueListGames.filter((g) => g.pricing === 'paid').length
          : memberPubs.reduce((s, p) => s + (Number(p.paid_games) || 0), 0);

        return {
          ...l,
          account_count: memberPubs.length,
          unique_games: uniqueGamesCount,
          total_listings: totalListings,
          total_games: uniqueGamesCount,
          free_games: uniqueFree,
          paid_games: uniquePaid,
          total_reviews: memberPubs.reduce((s, p) => s + (Number(p.total_reviews) || 0), 0)
        };
      });

      // Deduplicate portfolio-wide summary by ASIN while also reporting totalListings
      const uniqueByAsin = new Map();
      for (const g of games) {
        if (!uniqueByAsin.has(g.asin)) uniqueByAsin.set(g.asin, g);
      }
      const uniqueGamesArr = [...uniqueByAsin.values()];
      const uniqueGames = uniqueGamesArr.length;
      const totalListings = games.length;
      const freeGames = uniqueGamesArr.filter((g) => g.pricing === 'free').length;
      const paidGames = uniqueGamesArr.filter((g) => g.pricing === 'paid').length;
      const unknownGames = uniqueGamesArr.filter((g) => g.pricing === 'unknown').length;
      const totalReviews = uniqueGamesArr.reduce((s, g) => s + (Number(g.review_count) || 0), 0);

      // Fetch competitor groups / batches (e.g. 'Bahria' containing Trenzy + Gaminator)
      let competitorGroups = [];
      try {
        const groupsRes = await pool.query(`
          SELECT 
            g.id,
            g.name,
            COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS competitor_ids,
            COALESCE(array_agg(c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS competitor_names
          FROM competitor_groups g
          LEFT JOIN competitor_group_members gm ON g.id = gm.group_id
          LEFT JOIN competitors c ON gm.competitor_id = c.id
          GROUP BY g.id
          ORDER BY g.name ASC
        `);
        competitorGroups = (groupsRes.rows || []).map((row) => {
          const matchedLists = lists.filter((l) => (row.competitor_ids || []).includes(l.competitor_id));
          const pubIdSet = new Set();
          matchedLists.forEach((l) => (l.publisher_ids || []).forEach((pId) => pubIdSet.add(pId)));
          return {
            id: row.id,
            name: row.name,
            competitor_ids: row.competitor_ids || [],
            competitor_names: row.competitor_names || [],
            list_ids: matchedLists.map((l) => l.id),
            publisher_ids: Array.from(pubIdSet),
            account_count: pubIdSet.size
          };
        });
      } catch (_gErr) {
        // Table might not exist yet if not initialized
      }

      const payload = {
        summary: {
          publisherCount: publishers.length,
          listCount: lists.length,
          uniqueGames,
          totalListings,
          totalGames: uniqueGames,
          freeGames,
          paidGames,
          unknownGames,
          freeShare: uniqueGames ? freeGames / uniqueGames : 0,
          totalReviews
        },
        lists,
        competitorGroups,
        publishers,
        games,
        snapshots: snapsRes.rows
      };
      amazonOverviewCache = {
        payload,
        expiresAt: Date.now() + 90000
      };
      res.json(payload);
    } catch (err) {
      console.error('[Amazon Overview Error]:', err);
      res.status(500).json({ error: 'Failed to load Amazon intelligence overview.' });
    }
  });

  app.get('/api/amazon/scan-status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(amazonScanStatus);
  });

  app.post('/api/amazon/cancel-scan', (_req, res) => {
    if (!amazonScanStatus.running) {
      return res.json({ status: 'idle', message: 'No Amazon scan is currently running.' });
    }
    activeAmazonScanCancelled = true;
    amazonScanStatus = {
      ...amazonScanStatus,
      state: 'cancelling',
      log: '> 🛑 Abort requested. Saving all Amazon games collected so far...'
    };
    res.json({ status: 'success', message: 'Abort signal sent.' });
  });

  app.post('/api/amazon/scan', async (req, res) => {
    if (amazonScanStatus.running) {
      return res.status(409).json({ error: 'An Amazon scan is already running.' });
    }

    const links = parseInputLinks(req.body?.links || req.body?.urls || '');
    const batch = validateBatch(links);
    const validTargets = batch.filter((b) => b.valid && !b.duplicate);

    if (validTargets.length === 0) {
      return res.status(400).json({
        error: 'No valid, non-duplicate Amazon publisher links provided.',
        validation: batch
      });
    }

    // Resolve target list(s) if requested (existing list IDs and/or creating a new list on the fly)
    const targetListIds = new Set(
      (Array.isArray(req.body?.listIds) ? req.body.listIds : req.body?.listId ? [req.body.listId] : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    const newListName = String(req.body?.newListName || '').trim();
    let createdList = null;
    if (newListName) {
      try {
        const listRes = await pool.query(
          `INSERT INTO amazon_lists (name, description) VALUES ($1, $2) RETURNING *`,
          [newListName, req.body?.newListDescription || null]
        );
        createdList = listRes.rows[0];
        if (createdList?.id) targetListIds.add(createdList.id);
      } catch (err) {
        console.error('[Amazon Scan Create List Error]:', err.message);
      }
    }

    activeAmazonScanCancelled = false;
    amazonScanStatus = {
      running: true,
      state: 'scanning',
      phase: 'warming_up',
      isCancelled: false,
      isComplete: false,
      isError: false,
      currentPublisher: validTargets[0].publisher,
      publisherIndex: 1,
      completedPublishers: 0,
      totalPublishers: validTargets.length,
      currentPage: 0,
      totalPagesProcessed: 0,
      gamesFoundInCurrent: 0,
      totalGamesSaved: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultsSummary: [],
      failedLinks: [],
      log: `> 🚀 Starting Amazon batch scan for ${validTargets.length} publisher(s)...`
    };

    res.json({
      status: 'initiated',
      totalPublishers: validTargets.length,
      createdList,
      targetListIds: [...targetListIds],
      validation: batch
    });

    (async () => {
      let savedGamesTotal = 0;
      let doneCount = 0;
      let pagesTotal = 0;
      const resultsSummary = [];
      const failedLinks = [];
      try {
        await scanPublishers(
          validTargets.map((t) => t.normalizedUrl),
          {
            concurrency: 1,
            maxPages: 30,
            isCancelled: () => activeAmazonScanCancelled,
            onProgress: (p) => {
              const isRetry = p.phase === 'retrying';
              amazonScanStatus = {
                ...amazonScanStatus,
                phase: isRetry ? 'retrying' : 'scanning',
                currentPublisher: p.publisher,
                currentPage: p.page,
                gamesFoundInCurrent: p.found,
                log: isRetry
                  ? `> ↻ [${p.publisher}] Retrying page ${p.page} (attempt ${p.attempt})...`
                  : `> [${p.publisher}] Page ${p.page}: extracted ${p.found}${p.reportedTotal ? '/' + p.reportedTotal : ''} unique games...`
              };
            },
            onPublisherDone: async (r) => {
              doneCount += 1;
              pagesTotal += Number(r.pagesRead || 0);
              const gamesCount = r.games?.length || 0;
              resultsSummary.push({
                publisher: r.publisher,
                sourceUrl: r.sourceUrl,
                status: r.status,
                statusDetail: r.statusDetail || null,
                pagesRead: r.pagesRead || 0,
                gamesFound: gamesCount,
                freeGames: r.stats?.free || 0,
                paidGames: r.stats?.paid || 0
              });
              if ((r.status === 'blocked' || r.status === 'error' || r.status === 'skipped') && gamesCount === 0 && r.sourceUrl) {
                failedLinks.push(r.sourceUrl);
              }
              try {
                let pubId = null;
                if (r.games && r.games.length > 0) {
                  pubId = await savePublisherScanResult(pool, r);
                  savedGamesTotal += r.games.length;
                } else if (r.status !== 'skipped') {
                  pubId = await savePublisherScanResult(pool, r);
                }
                if (pubId && targetListIds.size > 0) {
                  for (const listId of targetListIds) {
                    await pool.query(
                      `INSERT INTO amazon_list_publishers (list_id, publisher_id)
                       VALUES ($1, $2)
                       ON CONFLICT DO NOTHING`,
                      [listId, pubId]
                    );
                  }
                }
              } catch (saveErr) {
                console.error(`[Amazon Save Error for ${r.publisher}]:`, saveErr.message);
              }
              amazonScanStatus = {
                ...amazonScanStatus,
                phase: r.status === 'blocked' ? 'blocked' : r.status === 'error' ? 'failed' : 'scanning',
                completedPublishers: doneCount,
                publisherIndex: Math.min(validTargets.length, doneCount + 1),
                totalPagesProcessed: pagesTotal,
                totalGamesSaved: savedGamesTotal,
                resultsSummary: [...resultsSummary],
                failedLinks: [...failedLinks],
                log: `> ${r.status === 'complete' || gamesCount > 0 ? '✔' : '⚠'} ${r.publisher} (${r.status}${r.statusDetail ? ': ' + r.statusDetail : ''}): saved ${gamesCount} games (${r.stats?.free || 0} free, ${r.stats?.paid || 0} paid).`
              };
              invalidateAmazonOverviewCache();
            }
          }
        );

        if (activeAmazonScanCancelled) {
          amazonScanStatus = {
            ...amazonScanStatus,
            running: false,
            state: 'cancelled',
            phase: 'cancelled',
            isCancelled: true,
            finishedAt: new Date().toISOString(),
            log: `> 🛑 Scan stopped by user. Saved ${savedGamesTotal} Amazon games across ${doneCount}/${validTargets.length} publisher(s).`
          };
        } else {
          const failedCount = failedLinks.length;
          amazonScanStatus = {
            ...amazonScanStatus,
            running: false,
            state: failedCount === validTargets.length && savedGamesTotal === 0 ? 'error' : 'complete',
            phase: failedCount > 0 ? 'completed_with_warnings' : 'completed',
            isComplete: true,
            isError: failedCount === validTargets.length && savedGamesTotal === 0,
            finishedAt: new Date().toISOString(),
            log:
              failedCount > 0
                ? `> ⚠ Scan finished: ${validTargets.length - failedCount}/${validTargets.length} succeeded (${savedGamesTotal} games saved, ${failedCount} failed/blocked).`
                : `> 🎉 Amazon scan complete! Synchronized ${savedGamesTotal} games across ${doneCount} publisher(s).`
          };
        }
        invalidateAmazonOverviewCache();
      } catch (err) {
        console.error('[Amazon Batch Scan Error]:', err);
        amazonScanStatus = {
          ...amazonScanStatus,
          running: false,
          state: 'error',
          phase: 'failed',
          isError: true,
          finishedAt: new Date().toISOString(),
          log: `> ❌ Amazon scan error: ${err.message} (Saved ${savedGamesTotal} games before error)`
        };
      }
    })();
  });

  // Rename publisher display_name and/or update its list memberships
  app.patch('/api/amazon/publishers/:id', async (req, res) => {
    try {
      const pubId = Number(req.params.id);
      if (!Number.isInteger(pubId)) return res.status(400).json({ error: 'Invalid publisher ID.' });

      if (req.body?.displayName !== undefined) {
        const cleanDisplay = String(req.body.displayName || '').trim() || null;
        await pool.query(
          `UPDATE amazon_publishers SET display_name = $2 WHERE id = $1`,
          [pubId, cleanDisplay]
        );
      }

      if (Array.isArray(req.body?.listIds)) {
        const cleanListIds = req.body.listIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
        await pool.query(`DELETE FROM amazon_list_publishers WHERE publisher_id = $1`, [pubId]);
        if (cleanListIds.length > 0) {
          await pool.query(
            `INSERT INTO amazon_list_publishers (list_id, publisher_id)
             SELECT unnest($1::int[]), $2::int
             ON CONFLICT DO NOTHING`,
            [cleanListIds, pubId]
          );
        }
      }

      res.json({ status: 'updated' });
    } catch (err) {
      console.error('[Amazon Update Publisher Error]:', err);
      res.status(500).json({ error: 'Failed to update publisher.' });
    }
  });

  app.delete('/api/amazon/publishers/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM amazon_publishers WHERE id = $1`, [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete publisher.' });
    }
  });

  // Create a new competitor list (and optionally assign existing publisher IDs)
  app.post('/api/amazon/lists', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'List name is required.' });
      const description = String(req.body?.description || '').trim() || null;

      const listRes = await pool.query(
        `INSERT INTO amazon_lists (name, description) VALUES ($1, $2) RETURNING *`,
        [name, description]
      );
      const list = listRes.rows[0];

      const pubIds = (Array.isArray(req.body?.publisherIds) ? req.body.publisherIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);

      if (pubIds.length > 0) {
        await pool.query(
          `INSERT INTO amazon_list_publishers (list_id, publisher_id)
           SELECT $1::int, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [list.id, pubIds]
        );
      }

      res.json({ status: 'created', list });
    } catch (err) {
      console.error('[Amazon Create List Error]:', err);
      res.status(500).json({ error: 'Failed to create list.' });
    }
  });

  // Rename a list or update its description
  app.patch('/api/amazon/lists/:id', async (req, res) => {
    try {
      const listId = Number(req.params.id);
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'List name is required.' });
      const description = req.body?.description !== undefined ? (String(req.body.description || '').trim() || null) : undefined;

      const updated = await pool.query(
        `UPDATE amazon_lists
         SET name = $2,
             description = COALESCE($3, description),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [listId, name, description ?? null]
      );
      res.json({ status: 'updated', list: updated.rows[0] });
    } catch (err) {
      console.error('[Amazon Rename List Error]:', err);
      res.status(500).json({ error: 'Failed to rename list.' });
    }
  });

  // Delete a list (keeps underlying publishers and games intact)
  app.delete('/api/amazon/lists/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM amazon_lists WHERE id = $1`, [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete list.' });
    }
  });

  // Add, remove, or set publishers in a list
  app.post('/api/amazon/lists/:id/publishers', async (req, res) => {
    try {
      const listId = Number(req.params.id);
      const action = req.body?.action || 'add'; // 'add' | 'remove' | 'set'
      const pubIds = (Array.isArray(req.body?.publisherIds) ? req.body.publisherIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);

      if (action === 'set') {
        await pool.query(`DELETE FROM amazon_list_publishers WHERE list_id = $1`, [listId]);
        if (pubIds.length > 0) {
          await pool.query(
            `INSERT INTO amazon_list_publishers (list_id, publisher_id)
             SELECT $1::int, unnest($2::int[])
             ON CONFLICT DO NOTHING`,
            [listId, pubIds]
          );
        }
      } else if (action === 'remove' && pubIds.length > 0) {
        await pool.query(
          `DELETE FROM amazon_list_publishers WHERE list_id = $1 AND publisher_id = ANY($2::int[])`,
          [listId, pubIds]
        );
      } else if (pubIds.length > 0) {
        await pool.query(
          `INSERT INTO amazon_list_publishers (list_id, publisher_id)
           SELECT $1::int, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [listId, pubIds]
        );
      }

      res.json({ status: 'updated' });
    } catch (err) {
      console.error('[Amazon List Membership Error]:', err);
      res.status(500).json({ error: 'Failed to update list publishers.' });
    }
  });
}

module.exports = {
  initializeAmazonStorage,
  registerAmazonRoutes,
  savePublisherScanResult,
  validateAmazonUrl
};
