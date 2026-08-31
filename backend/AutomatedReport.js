const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const db = require('./database'); // Pulls data directly from your database

// Your exact Google Sheet URL for the manager to click
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs/edit?pli=1&gid=705066303#gid=705066303";

async function generateAndSendReport(managerEmail, specificScanData = null) {
  console.log("📄 [REPORT ENGINE] Building custom data report...");
  let browser;

  try {
    // 1. Fetch overall database stats
    const stats = {
      competitors: db.prepare("SELECT COUNT(*) AS count FROM competitors").get().count,
      games: db.prepare("SELECT COUNT(*) AS count FROM games").get().count,
    };

    let tableData = [];
    let reportSubtitle = "";

    // 2. ISOLATION LOGIC
    if (specificScanData !== null) {
      // This is an on-demand manual scan
      tableData = specificScanData;
      reportSubtitle = `On-Demand Scan Summary • ${new Date().toLocaleDateString()}`;
    } else {
      // This is the 6 AM cron job - grab the top 10 from DB sorted by installs
      tableData = db.prepare(`
        SELECT g.title, a.publisher_name, g.category, g.rating, g.installs 
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        ORDER BY g.min_installs DESC LIMIT 10
      `).all();
      reportSubtitle = `Daily Automated Summary • ${new Date().toLocaleDateString()}`;
    }

    // 3. Build a native HTML template with the corrected tableData loop
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px; margin: 0; }
        .header { border-bottom: 2px solid #3b82f6; padding-bottom: 20px; margin-bottom: 30px; }
        .title { font-size: 32px; font-weight: bold; margin: 0; color: #adc6ff; }
        .subtitle { color: #94a3b8; font-size: 14px; margin-top: 8px; text-transform: uppercase; letter-spacing: 1px; }
        .grid { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; flex: 1; border: 1px solid #334155; }
        .card h3 { margin: 0 0 10px 0; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
        .card p { margin: 0; font-size: 32px; font-weight: bold; color: #4edea3; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; background: #1e293b; border-radius: 12px; overflow: hidden; }
        th, td { padding: 15px; text-align: left; border-bottom: 1px solid #334155; }
        th { color: #94a3b8; font-size: 12px; text-transform: uppercase; background: #0f172a; }
        td { font-size: 14px; color: #dce1fb; }
        .highlight { color: #3b82f6; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1 class="title">Atlas Intelligence Node</h1>
        <div class="subtitle">${reportSubtitle}</div>
      </div>
      
      <div class="grid">
        <div class="card">
          <h3>Tracked Competitors</h3>
          <p>${stats.competitors}</p>
        </div>
        <div class="card">
          <h3>Tracked Games</h3>
          <p>${stats.games}</p>
        </div>
        <div class="card">
          <h3>Database Status</h3>
          <p style="color: #3b82f6;">Synced</p>
        </div>
      </div>

      <h3 style="color: #adc6ff; margin-bottom: 15px;">Target Acquisitions</h3>
      <table>
        <thead>
          <tr>
            <th>Game Title</th>
            <th>Publisher</th>
            <th>Installs</th>
            <th>Rating</th>
          </tr>
        </thead>
        <tbody>
          ${tableData.map(game => `
            <tr>
              <td class="highlight">${game.title}</td>
              <td>${game.publisher_name || 'N/A'}</td>
              <td style="color: #10b981; font-weight: bold;">${game.installs || 'N/A'}</td>
              <td>⭐ ${game.rating || 'N/A'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </body>
    </html>
    `;

    // 4. Render PDF natively via Playwright
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle' });
    
    const pdfPath = path.join(__dirname, `Atlas_Daily_Report_${Date.now()}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true 
    });

    console.log(`📄 [REPORT ENGINE] Custom PDF generated: ${pdfPath}`);

    // 5. Configure Email (REMEMBER TO RE-PASTE YOUR APP PASSWORD HERE)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'danish1042awan@gmail.com', // Your sender email
        pass: 'pjpn glhk rhyr wgnl'      // Your 16-character App Password
      }
    });

    // 6. Send the Email
    const mailOptions = {
      from: '"Atlas Intelligence" <danish1042awan@gmail.com>', 
      to: managerEmail,
      subject: `📊 Atlas ASO Report - ${new Date().toLocaleDateString()}`,
      html: `
        <div style="font-family: sans-serif; color: #333;">
          <h2>Good morning,</h2>
          <p>Attached is the isolated summary PDF from your recent scan.</p>
          <p>For deep-dive velocity charts and full historical tracking, please view the live Google Sheet dashboard here:</p>
          <a href="${SHEET_URL}" style="background: #3b82f6; color: white; padding: 12px 18px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-top: 10px;">Open Live Charts Dashboard</a>
          <br><br>
          <p>- Atlas Intelligence Node</p>
        </div>
      `,
      attachments: [{ filename: `Atlas_Summary_${new Date().toISOString().split('T')[0]}.pdf`, path: pdfPath }]
    };

    await transporter.sendMail(mailOptions);
    console.log("✅ [REPORT ENGINE] Email sent successfully!");

    fs.unlinkSync(pdfPath); 

  } catch (error) {
    console.error("❌ [REPORT ENGINE ERROR]:", error);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { generateAndSendReport };