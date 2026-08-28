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
        SELECT g.title, g.category, g.rating, a.publisher_name 
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        WHERE g.package_name = ?
      `).get(pkg);

      if (game) {
        values.push([
          dateStr, 
          targetName, 
          game.publisher_name || "Unknown", 
          game.title || pkg, 
          pkg, 
          game.category || "N/A", 
          game.rating || "N/A"
        ]);
      }
    }

    if (values.length === 0) return;

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

module.exports = { pushScanToSheets };