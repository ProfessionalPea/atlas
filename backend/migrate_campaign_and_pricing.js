const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { google } = require('googleapis');
const { getDatabasePool } = require('./Security');
const pool = getDatabasePool();

async function run() {
  console.log('--- Step 1: Fix Pre-Register Apps incorrectly marked as Paid ($0.00) ---');
  const fixPaidRes = await pool.query(`
    UPDATE games
    SET is_paid = false, price = 0, price_text = 'Free'
    WHERE is_paid = true AND (price IS NULL OR price <= 0)
    RETURNING id, title, package_name
  `);
  console.log(`Updated ${fixPaidRes.rowCount} games from is_paid=true (with 0 price) to is_paid=false.`);

  console.log('\n--- Step 2: Ensure campaign_active and last_campaign_seen_at columns exist on games ---');
  await pool.query(`
    ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_active BOOLEAN DEFAULT false;
    ALTER TABLE games ADD COLUMN IF NOT EXISTS last_campaign_seen_at TIMESTAMPTZ;
  `);
  console.log('Columns verified on games table.');

  console.log('\n--- Step 3: Import Transparency Centre packages from Google Sheets Sheet1 ---');
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = '1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "'Sheet1'!E4:E"
  });

  const packagesInSheet = (res.data.values || [])
    .map(r => r[0] ? String(r[0]).trim().toLowerCase() : '')
    .filter(p => p.startsWith('com.'));

  const uniquePkgs = [...new Set(packagesInSheet)];
  console.log(`Found ${packagesInSheet.length} total rows, ${uniquePkgs.length} unique package names in Sheet1.`);

  const campaignUpdateRes = await pool.query(`
    UPDATE games
    SET campaign_active = true, last_campaign_seen_at = COALESCE(last_campaign_seen_at, now())
    WHERE LOWER(package_name) = ANY($1::text[])
    RETURNING id, package_name
  `, [uniquePkgs]);

  console.log(`Successfully flagged ${campaignUpdateRes.rowCount} games in Atlas database as campaign_active = true!`);

  console.log('\n--- Step 4: Recompute publisher free_games and paid_games aggregates ---');
  await pool.query(`
    UPDATE play_publishers p
    SET
      free_games = COALESCE(sub.free_cnt, 0),
      paid_games = COALESCE(sub.paid_cnt, 0),
      total_games = COALESCE(sub.total_cnt, 0)
    FROM (
      SELECT
        ag.account_id,
        COUNT(DISTINCT g.id)::int AS total_cnt,
        COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = false OR COALESCE(g.price, 0) <= 0)::int AS free_cnt,
        COUNT(DISTINCT g.id) FILTER (WHERE COALESCE(g.is_paid, false) = true AND COALESCE(g.price, 0) > 0)::int AS paid_cnt
      FROM account_games ag
      JOIN games g ON g.id = ag.game_id AND COALESCE(g.is_suspended, false) = false
      GROUP BY ag.account_id
    ) sub
    WHERE p.id = sub.account_id
  `);
  console.log('Play publisher statistics updated.');

  console.log('\n--- Migration & Sheet Campaign Import Complete! ---');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
