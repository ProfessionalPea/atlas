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
  isCancelled: false,
  isComplete: false,
  isError: false,
  currentPublisher: null,
  publisherIndex: 0,
  totalPublishers: 0,
  currentPage: 0,
  gamesFoundInCurrent: 0,
  totalGamesSaved: 0,
  startedAt: null,
  finishedAt: null,
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
  // do not overwrite existing game counts with zeros.
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

  const pubUpsert = await pool.query(
    `INSERT INTO amazon_publishers (
       publisher_name, normalized_name, host, source_url,
       total_games, free_games, paid_games, unknown_games,
       free_share, free_to_paid_ratio, avg_paid_price, median_paid_price, currency,
       avg_rating, total_reviews, free_review_share,
       last_scan_status, last_scan_detail, last_scanned_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, $16,
       $17, $18, now()
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
       last_scanned_at = now()
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
      r.statusDetail || null
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
       ON CONFLICT (asin) DO UPDATE SET
         publisher_id = EXCLUDED.publisher_id,
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
      UNIQUE (host, normalized_name)
    );

    CREATE TABLE IF NOT EXISTS amazon_games (
      asin TEXT PRIMARY KEY,
      publisher_id INTEGER REFERENCES amazon_publishers(id) ON DELETE CASCADE,
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
      last_seen_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_amazon_games_publisher_id ON amazon_games(publisher_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_games_pricing ON amazon_games(pricing);

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
}

function parseInputLinks(raw) {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => String(item || '').split(/[\r\n]+/)).map((s) => s.trim()).filter(Boolean);
  }
  return String(raw || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

function registerAmazonRoutes({ app, pool }) {
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

  app.get('/api/amazon/overview', async (_req, res) => {
    try {
      const [pubsRes, gamesRes, snapsRes] = await Promise.all([
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
        `)
      ]);

      const publishers = pubsRes.rows;
      const games = gamesRes.rows;
      const totalGames = games.length;
      const freeGames = games.filter((g) => g.pricing === 'free').length;
      const paidGames = games.filter((g) => g.pricing === 'paid').length;
      const unknownGames = games.filter((g) => g.pricing === 'unknown').length;
      const totalReviews = games.reduce((s, g) => s + (Number(g.review_count) || 0), 0);

      res.json({
        summary: {
          publisherCount: publishers.length,
          totalGames,
          freeGames,
          paidGames,
          unknownGames,
          freeShare: totalGames ? freeGames / totalGames : 0,
          totalReviews
        },
        publishers,
        games,
        snapshots: snapsRes.rows
      });
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

    activeAmazonScanCancelled = false;
    amazonScanStatus = {
      running: true,
      state: 'scanning',
      isCancelled: false,
      isComplete: false,
      isError: false,
      currentPublisher: validTargets[0].publisher,
      publisherIndex: 1,
      totalPublishers: validTargets.length,
      currentPage: 0,
      gamesFoundInCurrent: 0,
      totalGamesSaved: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: `> 🚀 Starting Amazon batch scan for ${validTargets.length} publisher(s)...`
    };

    res.json({
      status: 'initiated',
      totalPublishers: validTargets.length,
      validation: batch
    });

    (async () => {
      let savedGamesTotal = 0;
      let doneCount = 0;
      try {
        await scanPublishers(
          validTargets.map((t) => t.normalizedUrl),
          {
            concurrency: 1,
            maxPages: 30,
            isCancelled: () => activeAmazonScanCancelled,
            onProgress: (p) => {
              amazonScanStatus = {
                ...amazonScanStatus,
                currentPublisher: p.publisher,
                currentPage: p.page,
                gamesFoundInCurrent: p.found,
                log: `> [${p.publisher}] Page ${p.page}: extracted ${p.found}${p.reportedTotal ? '/' + p.reportedTotal : ''} unique games...`
              };
            },
            onPublisherDone: async (r) => {
              doneCount += 1;
              try {
                if (r.games && r.games.length > 0) {
                  await savePublisherScanResult(pool, r);
                  savedGamesTotal += r.games.length;
                } else if (r.status !== 'skipped') {
                  await savePublisherScanResult(pool, r);
                }
              } catch (saveErr) {
                console.error(`[Amazon Save Error for ${r.publisher}]:`, saveErr.message);
              }
              amazonScanStatus = {
                ...amazonScanStatus,
                publisherIndex: Math.min(validTargets.length, doneCount + 1),
                totalGamesSaved: savedGamesTotal,
                log: `> ✔ ${r.publisher} (${r.status}): saved ${r.games?.length || 0} games (${r.stats?.free || 0} free, ${r.stats?.paid || 0} paid).`
              };
            }
          }
        );

        if (activeAmazonScanCancelled) {
          amazonScanStatus = {
            ...amazonScanStatus,
            running: false,
            state: 'cancelled',
            isCancelled: true,
            finishedAt: new Date().toISOString(),
            log: `> 🛑 Scan stopped by user. Saved ${savedGamesTotal} Amazon games collected so far.`
          };
        } else {
          amazonScanStatus = {
            ...amazonScanStatus,
            running: false,
            state: 'complete',
            isComplete: true,
            finishedAt: new Date().toISOString(),
            log: `> 🎉 Amazon scan complete! Synchronized ${savedGamesTotal} unique games across ${doneCount} publisher(s).`
          };
        }
      } catch (err) {
        console.error('[Amazon Batch Scan Error]:', err);
        amazonScanStatus = {
          ...amazonScanStatus,
          running: false,
          state: 'error',
          isError: true,
          finishedAt: new Date().toISOString(),
          log: `> ❌ Amazon scan error: ${err.message} (Saved ${savedGamesTotal} games before error)`
        };
      }
    })();
  });

  app.delete('/api/amazon/publishers/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM amazon_publishers WHERE id = $1`, [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete publisher.' });
    }
  });
}

module.exports = {
  initializeAmazonStorage,
  registerAmazonRoutes,
  savePublisherScanResult,
  validateAmazonUrl
};
