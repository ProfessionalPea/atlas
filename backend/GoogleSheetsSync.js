const { google } = require('googleapis');
const path = require('path');

// Your exact Spreadsheet ID
const SPREADSHEET_ID = '1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs';

async function pushScanToSheets(db, targetName, packagesArray) {
  try {
    // 1. Authenticate using your bot credentials
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, 'google-credentials.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    
    // 2. Prepare the data timestamp
    const dateStr = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
    let values = [];
    
  // 3. Enrich the raw package names with full SQLite data
    for (const pkg of packagesArray) {
      const game = db.prepare(`
        SELECT g.title, g.category, g.rating, g.installs, g.min_installs, g.released, g.updated, a.publisher_name 
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        WHERE g.package_name = ?
      `).get(pkg);

      if (game) {
        // Convert the UNIX timestamp for "updated" to a readable date
        const updatedDate = game.updated ? new Date(game.updated).toLocaleDateString() : "Unknown";

        values.push([
          dateStr, 
          targetName, 
          game.publisher_name || "Unknown", 
          game.title || pkg, 
          pkg, 
          game.category || "N/A", 
          game.rating || "N/A",
          game.installs || "0+",        // NEW: "10,000,000+"
          game.min_installs || 0,       // NEW: 10000000 (Perfect for Sheets sorting!)
          game.released || "Unknown",   // NEW: "Aug 21, 2023"
          updatedDate                   // NEW: Last update date
        ]);
      }
    }

    // 4. Push the batch to Google Sheets (Appending to the bottom)
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:G', // Assumes columns A through G
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    console.log(`📊 [Google Sheets] Successfully synchronized ${values.length} records for ${targetName}`);
  } catch (error) {
    console.error('❌ [Google Sheets Error]:', error.message);
  }
}

// Helper to convert column index to letters (e.g., 0 -> A, 1 -> B, 26 -> AA)
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
// The new Publisher Link Sync Engine
async function syncPublisherLinksToSheets(db, competitorName, adsId) {
  console.log(`\n⚙️ [Publisher Sync] Waking up for target: "${competitorName}" (ID: ${adsId || "None"})`);
  
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: "google-credentials.json", 
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const SHEET_ID = "1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs";
    const sheetTabName = "'Competitor Analysis'"; 

    // SMART HEADER: If the name is "Playmax", it outputs "Playmax [AR123...]". 
    // If the name is already "Unsaved (AR123...)", it won't duplicate the ID.
    const expectedHeader = (adsId && !competitorName.includes(adsId)) 
      ? `${competitorName} [${adsId}]` 
      : competitorName;

    const accounts = db.prepare(`
      SELECT DISTINCT a.publisher_name 
      FROM accounts a JOIN competitors c ON a.competitor_id = c.id
      WHERE c.name = ?
    `).all(competitorName);

    if (accounts.length === 0) return;

    const urls = accounts.map(acc => {
      const encodedName = encodeURIComponent(acc.publisher_name).replace(/%20/g, '+');
      return [`https://play.google.com/store/apps/developer?id=${encodedName}`];
    });

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetTabName}!1:1`,
    });

    let headers = headerRes.data.values ? headerRes.data.values[0] : [];
    
    // SMART COLUMN HUNTING
    let colIndex = -1;
    
    // 1. Look for the exact new header
    colIndex = headers.indexOf(expectedHeader);
    
    // 2. Look for the raw AR ID anywhere in the existing columns (This fixes your current sheet!)
    if (colIndex === -1 && adsId) colIndex = headers.findIndex(h => h && h.includes(adsId));
    
    // 3. Fallback to just the name
    if (colIndex === -1) colIndex = headers.indexOf(competitorName);

    if (colIndex === -1) {
      colIndex = headers.length;
      headers.push(expectedHeader);
    } else {
      headers[colIndex] = expectedHeader; // Instantly upgrades old "AR..." columns to "Playmax [AR...]"
    }
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${sheetTabName}!1:1`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [headers] }
    });

    const colLetter = getColumnLetter(colIndex);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID, range: `${sheetTabName}!${colLetter}2:${colLetter}`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${sheetTabName}!${colLetter}2`,
      valueInputOption: "USER_ENTERED", requestBody: { values: urls }
    });

    console.log(`✅ [Google Sheets] Synced column ${colLetter} -> ${expectedHeader}`);

  } catch (err) {
    console.error(`❌ [Google Sheets] Publisher Sync Failed:`, err);
  }
}

module.exports = { pushScanToSheets, syncPublisherLinksToSheets };

module.exports = { pushScanToSheets, syncPublisherLinksToSheets };