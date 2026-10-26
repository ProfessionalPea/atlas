// One-off backfill: populate released / release_date / short_description / description
// from Google Play ds:5 for games scanned after google-play-scraper stopped returning `released`.
// Run from c:\atlas\backend:  node scripts/backfill-release-dates.js
require('dotenv').config();
const { getDatabasePool } = require('../Security');
const { fetchPlayStoreDs5 } = require('../PlayStoreTelemetry');

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY) || 4;

(async () => {
  const pool = getDatabasePool();

  // 1. Cheap fix: rows that already have release_date but released = 'Unknown'
  const quick = await pool.query(`
    UPDATE games SET released = to_char(release_date, 'Mon FMDD, YYYY')
    WHERE release_date IS NOT NULL AND (released IS NULL OR released = '' OR released = 'Unknown')`);
  console.log(`Copied release_date -> released for ${quick.rowCount} games`);

  // 2. Fetch ds:5 for rows still missing data
  const { rows } = await pool.query(`
    SELECT package_name FROM games
    WHERE release_date IS NULL
       OR released IS NULL OR released = 'Unknown'
       OR COALESCE(short_description, '') = ''
    ORDER BY id DESC`);
  console.log(`Fetching ds:5 for ${rows.length} games (concurrency ${CONCURRENCY})...`);

  let next = 0, ok = 0, failed = 0;
  const worker = async () => {
    while (next < rows.length) {
      const pkg = rows[next++].package_name;
      try {
        const ds5 = await fetchPlayStoreDs5(pkg, { timeoutMs: 15000 });
        await pool.query(`
          UPDATE games SET
            release_date = COALESCE(release_date, $2::date),
            released = CASE WHEN (released IS NULL OR released = '' OR released = 'Unknown') AND $3::text IS NOT NULL
                            THEN $3::text ELSE released END,
            short_description = COALESCE(NULLIF(short_description, ''), NULLIF($4::text, '')),
            description = CASE WHEN (description IS NULL OR description = '' OR description = 'Captured directly via ad stream')
                                AND NULLIF($5::text, '') IS NOT NULL THEN $5::text ELSE description END
          WHERE package_name = $1`,
          [pkg, ds5.releaseDate, ds5.rawReleaseDate || ds5.releaseDate || null, ds5.shortDescription || null, ds5.longDescription || null]);
        ok++;
      } catch (err) {
        failed++;
        console.warn(`  ${pkg}: ${err.message}`);
      }
      if ((ok + failed) % 25 === 0) console.log(`  progress ${ok + failed}/${rows.length} (ok ${ok}, failed ${failed})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const summary = await pool.query(`
    SELECT COUNT(*) total,
           COUNT(*) FILTER (WHERE release_date IS NOT NULL) with_release_date,
           COUNT(*) FILTER (WHERE released <> 'Unknown') with_released,
           COUNT(*) FILTER (WHERE COALESCE(short_description,'') <> '') with_short_desc
    FROM games`);
  console.log('Done.', { ok, failed, ...summary.rows[0] });
  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
