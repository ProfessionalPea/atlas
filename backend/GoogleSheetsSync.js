const { google } = require('googleapis');
const path = require('path');

async function pushScanToSheets(pool, targetName, packagesArray) {
  try {
    // 1. Dual Authentication (Local File vs Cloud Environment Variable)
    let authConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else {
      authConfig.keyFile = path.join(__dirname, 'google-credentials.json');
    }
    
    const auth = new google.auth.GoogleAuth(authConfig);
    const sheets = google.sheets({ version: 'v4', auth });
    
    // Dynamically fetch target sheet from Postgres settings
    const settingsQuery = await pool.query("SELECT value FROM settings WHERE key = 'google_sheet_id'");
    const sheetId = settingsQuery.rows[0]?.value || '1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs';

    // 2. Prepare the data timestamp
    const dateStr = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
    let values = [];
    
    // 3. Enrich the raw package names with full PostgreSQL data
    for (const pkg of packagesArray) {
      const { rows } = await pool.query(`
        SELECT g.title, g.category, g.rating, g.installs, g.min_installs, g.released, g.updated, a.publisher_name 
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        WHERE g.package_name = $1 LIMIT 1
      `, [pkg]);

      const game = rows[0];

      if (game) {
        // Convert the UNIX timestamp for "updated" to a readable date
        let updatedDate = "Unknown";
        if (game.updated) {
          const timestamp = typeof game.updated === 'number' ? game.updated : new Date(game.updated).getTime();
          if (!isNaN(timestamp)) updatedDate = new Date(timestamp).toLocaleDateString();
        }

        values.push([
          dateStr, 
          targetName, 
          game.publisher_name || "Unknown", 
          game.title || pkg, 
          pkg, 
          game.category || "N/A", 
          game.rating || "N/A",
          game.installs || "0+",
          game.min_installs || 0,
          game.released || "Unknown",
          updatedDate
        ]);
      }
    }

    if (values.length === 0) return;

    // 4. Push the batch to Google Sheets (Appending to the bottom)
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:K', // Assumes columns A through K are configured
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    console.log(`📊 [Google Sheets] Successfully synchronized ${values.length} records for ${targetName}`);
  } catch (error) {
    console.error('❌ [Google Sheets Error]:', error.message);
  }
}

// Helper to convert column index to letters (e.g., 0 -> A, 1 -> B, 26 -> AA)
function getColumnLetter(colIndex) {
  let letter = '';
  while (colIndex >= 0) {
    letter = String.fromCharCode((colIndex % 26) + 65) + letter;
    colIndex = Math.floor(colIndex / 26) - 1;
  }
  return letter;
}

// ----------------------------------------------------
// THE BULLETPROOF PUBLISHER SYNC ENGINE
// ----------------------------------------------------
async function syncPublisherLinksToSheets(pool, competitorName, adsId) {
  console.log(`\n⚙️ [Publisher Sync] Waking up for target: "${competitorName}" (ID: ${adsId || "None"})`);
  
  try {
    let authConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else {
      authConfig.keyFile = path.join(__dirname, 'google-credentials.json');
    }
    
    const auth = new google.auth.GoogleAuth(authConfig);
    const sheets = google.sheets({ version: "v4", auth });

    const settingsQuery = await pool.query("SELECT value FROM settings WHERE key = 'google_sheet_id'");
    const sheetId = settingsQuery.rows[0]?.value || '1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs';
    const sheetTabName = "'Competitor Analysis'"; 

    const expectedHeader = (adsId && !competitorName.includes(adsId)) 
      ? `${competitorName} [${adsId}]` 
      : competitorName;

    // Postgres Query
    const { rows: accounts } = await pool.query(`
      SELECT DISTINCT a.publisher_name 
      FROM accounts a JOIN competitors c ON a.competitor_id = c.id
      WHERE c.name = $1
    `, [competitorName]);

    if (accounts.length === 0) return;

    const urls = accounts.map(acc => {
      const encodedName = encodeURIComponent(acc.publisher_name).replace(/%20/g, '+');
      return [`https://play.google.com/store/apps/developer?id=${encodedName}`];
    });

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetTabName}!1:1`,
    });

    let headers = headerRes.data.values ? headerRes.data.values[0] : [];
    
    let colIndex = -1;
    colIndex = headers.indexOf(expectedHeader);
    if (colIndex === -1 && adsId) colIndex = headers.findIndex(h => h && h.includes(adsId));
    if (colIndex === -1) colIndex = headers.indexOf(competitorName);

    if (colIndex === -1) {
      colIndex = headers.length;
      headers.push(expectedHeader);
    } else {
      headers[colIndex] = expectedHeader;
    }
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${sheetTabName}!1:1`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [headers] }
    });

    const colLetter = getColumnLetter(colIndex);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId, range: `${sheetTabName}!${colLetter}2:${colLetter}`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${sheetTabName}!${colLetter}2`,
      valueInputOption: "USER_ENTERED", requestBody: { values: urls }
    });

    console.log(`✅ [Google Sheets] Synced column ${colLetter} -> ${expectedHeader}`);

  } catch (err) {
    console.error(`❌ [Google Sheets] Publisher Sync Failed:`, err.message);
  }
}

module.exports = { pushScanToSheets, syncPublisherLinksToSheets };