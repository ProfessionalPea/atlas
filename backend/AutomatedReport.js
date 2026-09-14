require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const cleanConnectionString = (process.env.DATABASE_URL || "").split("?")[0];

const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false },
});

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1tQysvSfuGZ3p9sydcueagW4fS_h2PufqDN0nx3i7ohs/edit?pli=1&gid=705066303#gid=705066303";

const FALLBACK_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='1.5'%3E%3Crect width='20' height='20' x='2' y='2' rx='5'/%3E%3Cpath d='M6 12h4m-2-2v4m7-2h.01m3 0h.01'/%3E%3C/svg%3E";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCompact(value, suffix = "") {
  const num = Number(value) || 0;
  let formatted;

  if (num >= 1_000_000_000) {
    formatted = `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  } else if (num >= 1_000_000) {
    formatted = `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  } else if (num >= 1_000) {
    formatted = `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  } else {
    formatted = num.toLocaleString("en-US");
  }

  return `${formatted}${suffix}`;
}

function formatDate(value) {
  if (!value || value === "Unknown" || value === 0) return "Unknown";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getAdCount(game) {
  return Math.max(
    0,
    Number(game.scan_ads ?? game.scan_ad_count ?? game.total_ads ?? game.ad_count ?? 0) || 0
  );
}

function getInstallFloor(game) {
  const numeric = Number(game.min_installs);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const parsed = Number(String(game.installs || "").replace(/[^0-9]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getInstallLabel(game) {
  if (game.installs && game.installs !== "0+") return String(game.installs);

  const floor = getInstallFloor(game);
  return floor > 0 ? `${formatCompact(floor)}+` : "New / 0+";
}

function getIconUrl(game) {
  return game.icon && /^https?:\/\//i.test(game.icon) ? game.icon : FALLBACK_ICON;
}

async function enrichManualScanData(scanData) {
  if (!Array.isArray(scanData) || scanData.length === 0) return [];

  const packageNames = [
    ...new Set(scanData.map((game) => game.package_name).filter(Boolean)),
  ];

  let databaseRows = [];

  if (packageNames.length > 0) {
    const { rows } = await pool.query(
      `
        SELECT DISTINCT ON (g.package_name)
          g.package_name,
          g.title,
          g.icon,
          g.category,
          g.rating,
          g.ratings_count,
          g.installs,
          g.min_installs,
          g.ad_count,
          g.released,
          g.updated,
          a.publisher_name
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        WHERE g.package_name = ANY($1::text[])
        ORDER BY g.package_name, g.ad_count DESC
      `,
      [packageNames]
    );
    databaseRows = rows;
  } else {
    const titles = [...new Set(scanData.map((game) => game.title).filter(Boolean))];

    if (titles.length > 0) {
      const { rows } = await pool.query(
        `
          SELECT DISTINCT ON (g.title)
            g.package_name,
            g.title,
            g.icon,
            g.category,
            g.rating,
            g.ratings_count,
            g.installs,
            g.min_installs,
            g.ad_count,
            g.released,
            g.updated,
            a.publisher_name
          FROM games g
          LEFT JOIN account_games ag ON g.id = ag.game_id
          LEFT JOIN accounts a ON ag.account_id = a.id
          WHERE g.title = ANY($1::text[])
          ORDER BY g.title, g.ad_count DESC
        `,
        [titles]
      );
      databaseRows = rows;
    }
  }

  const byPackage = new Map(
    databaseRows.filter((row) => row.package_name).map((row) => [row.package_name, row])
  );
  const byTitle = new Map(
    databaseRows.filter((row) => row.title).map((row) => [row.title, row])
  );

  return scanData.map((game) => {
    const dbGame =
      (game.package_name && byPackage.get(game.package_name)) || byTitle.get(game.title) || {};

    return {
      ...dbGame,
      ...game,
      package_name: game.package_name || dbGame.package_name || "",
      publisher_name: game.publisher_name || dbGame.publisher_name || "Unknown Publisher",
      icon: game.icon || dbGame.icon || null,
      category: game.category || dbGame.category || "N/A",
      rating: game.rating ?? dbGame.rating ?? 0,
      ratings_count: game.ratings_count ?? dbGame.ratings_count ?? 0,
      installs: game.installs || dbGame.installs || "0+",
      min_installs: game.min_installs ?? dbGame.min_installs ?? 0,
      released: game.released || dbGame.released || "Unknown",
      updated: game.updated || dbGame.updated || 0,
      ad_count: game.ad_count ?? dbGame.ad_count ?? 0,
    };
  });
}

async function generateAndSendReport(managerEmail, specificScanData = null) {
  console.log("📄 [REPORT ENGINE] Building executive intelligence brief...");

  let browser;
  let pdfPath = null;

  try {
    let tableData = [];
    let reportSubtitle = "";
    let reportMode = "Daily";

    if (specificScanData !== null) {
      tableData = await enrichManualScanData(specificScanData);
      reportMode = "On-Demand";
      reportSubtitle = `On-Demand Scan Intelligence • ${new Date().toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric", year: "numeric" }
      )}`;
    } else {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (g.package_name)
          g.package_name,
          g.title,
          g.icon,
          a.publisher_name,
          g.category,
          g.rating,
          g.ratings_count,
          g.installs,
          g.min_installs,
          g.ad_count AS total_ads,
          g.released,
          g.updated
        FROM games g
        LEFT JOIN account_games ag ON g.id = ag.game_id
        LEFT JOIN accounts a ON ag.account_id = a.id
        ORDER BY g.package_name, g.ad_count DESC, g.min_installs DESC
      `);

      tableData = rows
        .sort((a, b) => {
          const adsDiff = getAdCount(b) - getAdCount(a);
          if (adsDiff !== 0) return adsDiff;
          return getInstallFloor(b) - getInstallFloor(a);
        })
        .slice(0, 15);

      reportSubtitle = `Daily Automated Intelligence Brief • ${new Date().toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric", year: "numeric" }
      )}`;
    }

    tableData = [...tableData].sort((a, b) => {
      const adsDiff = getAdCount(b) - getAdCount(a);
      if (adsDiff !== 0) return adsDiff;
      return getInstallFloor(b) - getInstallFloor(a);
    });

    const reportStats = {
      games: tableData.length,
      ads: tableData.reduce((sum, game) => sum + getAdCount(game), 0),
      publishers: new Set(
        tableData.map((game) => game.publisher_name).filter(Boolean)
      ).size,
      installFloor: tableData.reduce((sum, game) => sum + getInstallFloor(game), 0),
    };

    const topGame = tableData[0] || null;

    const cardsHtml = tableData
      .map((game, index) => {
        const iconUrl = getIconUrl(game);
        const adCount = getAdCount(game);
        const installs = getInstallLabel(game);
        const rating = Number(game.rating) > 0 ? Number(game.rating).toFixed(1) : "N/A";
        const ratingsCount = Number(game.ratings_count) || 0;

        return `
          <article class="game-card">
            <div class="rank">#${index + 1}</div>

            <div class="game-heading">
              <img
                src="${escapeHtml(iconUrl)}"
                class="game-icon"
                alt=""
                onerror="this.src='${FALLBACK_ICON}'"
              />

              <div class="game-copy">
                <div class="game-title">${escapeHtml(game.title || "Untitled App")}</div>
                <div class="publisher">${escapeHtml(
                  game.publisher_name || "Unknown Publisher"
                )}</div>
                <div class="package">${escapeHtml(game.package_name || "N/A")}</div>
              </div>
            </div>

            <div class="metric-grid">
              <div class="metric metric-red">
                <span class="metric-label">Ads Seen</span>
                <strong>${formatCompact(adCount)}</strong>
              </div>

              <div class="metric metric-green">
                <span class="metric-label">Installs</span>
                <strong>${escapeHtml(installs)}</strong>
              </div>

              <div class="metric metric-amber">
                <span class="metric-label">Rating</span>
                <strong>${rating === "N/A" ? "N/A" : `${rating} ★`}</strong>
              </div>

              <div class="metric">
                <span class="metric-label">Ratings</span>
                <strong>${ratingsCount > 0 ? formatCompact(ratingsCount) : "N/A"}</strong>
              </div>
            </div>

            <div class="metadata-row">
              <span><b>Category:</b> ${escapeHtml(game.category || "N/A")}</span>
              <span><b>Released:</b> ${escapeHtml(formatDate(game.released))}</span>
              <span><b>Updated:</b> ${escapeHtml(formatDate(game.updated))}</span>
            </div>
          </article>
        `;
      })
      .join("");

    const emptyStateHtml = `
      <div class="empty-state">
        No games were available for this report.
      </div>
    `;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #0b0f19;
            color: #f8fafc;
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          .page {
            padding: 28px;
          }

          .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 24px;
            border-bottom: 2px solid #2563eb;
            padding-bottom: 18px;
            margin-bottom: 20px;
          }

          .eyebrow {
            color: #60a5fa;
            font-size: 9px;
            font-weight: 800;
            letter-spacing: 1.6px;
            text-transform: uppercase;
            margin-bottom: 7px;
          }

          .title {
            font-size: 25px;
            line-height: 1.05;
            font-weight: 900;
            margin: 0;
            letter-spacing: -0.6px;
          }

          .subtitle {
            color: #94a3b8;
            font-size: 10px;
            margin-top: 7px;
            letter-spacing: 0.6px;
            text-transform: uppercase;
          }

          .mode-pill {
            border: 1px solid #334155;
            background: #111827;
            color: #cbd5e1;
            padding: 7px 10px;
            border-radius: 999px;
            font-size: 9px;
            font-weight: 800;
            letter-spacing: 0.8px;
            text-transform: uppercase;
            white-space: nowrap;
          }

          .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-bottom: 16px;
          }

          .summary-card {
            background: #111827;
            border: 1px solid #1f2937;
            border-radius: 12px;
            padding: 13px;
          }

          .summary-label {
            color: #64748b;
            font-size: 8px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 1px;
          }

          .summary-value {
            margin-top: 5px;
            font-size: 22px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-weight: 900;
            color: #f8fafc;
          }

          .summary-value.blue { color: #60a5fa; }
          .summary-value.green { color: #34d399; }
          .summary-value.red { color: #fb7185; }

          .highlight-box {
            border: 1px solid #1e3a5f;
            background: linear-gradient(135deg, rgba(37, 99, 235, 0.16), rgba(15, 23, 42, 0.5));
            border-radius: 12px;
            padding: 12px 14px;
            margin-bottom: 18px;
            color: #cbd5e1;
            font-size: 10px;
          }

          .highlight-box strong { color: #f8fafc; }

          .section-title {
            margin: 0 0 10px;
            color: #94a3b8;
            font-size: 10px;
            font-weight: 900;
            letter-spacing: 1.2px;
            text-transform: uppercase;
          }

          .game-card {
            position: relative;
            background: #111827;
            border: 1px solid #1f2937;
            border-radius: 14px;
            padding: 14px;
            margin-bottom: 12px;
            break-inside: avoid;
            page-break-inside: avoid;
          }

          .rank {
            position: absolute;
            top: 12px;
            right: 12px;
            color: #475569;
            font-size: 9px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-weight: 800;
          }

          .game-heading {
            display: flex;
            align-items: center;
            gap: 12px;
            padding-right: 34px;
          }

          .game-icon {
            width: 58px;
            height: 58px;
            flex: 0 0 58px;
            border-radius: 13px;
            object-fit: cover;
            background: #0f172a;
            border: 1px solid #334155;
          }

          .game-copy { min-width: 0; }

          .game-title {
            color: #f8fafc;
            font-size: 15px;
            font-weight: 800;
            line-height: 1.2;
          }

          .publisher {
            color: #94a3b8;
            font-size: 10px;
            margin-top: 3px;
          }

          .package {
            color: #64748b;
            font-size: 8px;
            margin-top: 4px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            word-break: break-all;
          }

          .metric-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-top: 12px;
          }

          .metric {
            background: #0b1220;
            border: 1px solid #1f2937;
            border-radius: 9px;
            padding: 9px;
          }

          .metric-label {
            display: block;
            color: #64748b;
            font-size: 7px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 4px;
          }

          .metric strong {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 11px;
            color: #e2e8f0;
          }

          .metric-red strong { color: #fb7185; }
          .metric-green strong { color: #34d399; }
          .metric-amber strong { color: #fbbf24; }

          .metadata-row {
            display: flex;
            flex-wrap: wrap;
            gap: 7px 16px;
            border-top: 1px solid #1f2937;
            padding-top: 9px;
            margin-top: 10px;
            color: #64748b;
            font-size: 8px;
          }

          .metadata-row b { color: #94a3b8; }

          .empty-state {
            background: #111827;
            border: 1px dashed #334155;
            border-radius: 12px;
            color: #64748b;
            text-align: center;
            padding: 40px 20px;
            font-size: 11px;
          }

          .footer {
            display: flex;
            justify-content: space-between;
            gap: 20px;
            margin-top: 18px;
            border-top: 1px solid #1f2937;
            padding-top: 10px;
            color: #475569;
            font-size: 8px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            letter-spacing: 0.4px;
          }
        </style>
      </head>
      <body>
        <main class="page">
          <header class="header">
            <div>
              <div class="eyebrow">Atlas Intelligence Node</div>
              <h1 class="title">Competitive Intelligence Report</h1>
              <div class="subtitle">${escapeHtml(reportSubtitle)}</div>
            </div>
            <div class="mode-pill">${escapeHtml(reportMode)} Report</div>
          </header>

          <section class="summary-grid">
            <div class="summary-card">
              <div class="summary-label">Games Found</div>
              <div class="summary-value blue">${reportStats.games}</div>
            </div>

            <div class="summary-card">
              <div class="summary-label">Ads Mapped</div>
              <div class="summary-value red">${formatCompact(reportStats.ads)}</div>
            </div>

            <div class="summary-card">
              <div class="summary-label">Publishers</div>
              <div class="summary-value">${reportStats.publishers}</div>
            </div>

            <div class="summary-card">
              <div class="summary-label">Combined Install Floor</div>
              <div class="summary-value green">${formatCompact(
                reportStats.installFloor,
                reportStats.installFloor > 0 ? "+" : ""
              )}</div>
            </div>
          </section>

          ${
            topGame
              ? `<div class="highlight-box">
                  <strong>Top signal:</strong>
                  ${escapeHtml(topGame.title || "Unknown Game")} leads this report with
                  <strong>${formatCompact(getAdCount(topGame))} ad${
                    getAdCount(topGame) === 1 ? "" : "s"
                  }</strong>
                  and <strong>${escapeHtml(getInstallLabel(topGame))} installs</strong>.
                </div>`
              : ""
          }

          <section>
            <h2 class="section-title">Game Intelligence — Ranked by Ad Activity</h2>
            ${cardsHtml || emptyStateHtml}
          </section>

          <footer class="footer">
            <span>GENERATED VIA ATLAS INTELLIGENCE ENGINE</span>
            <span>CONFIDENTIAL • INTERNAL USE ONLY</span>
          </footer>
        </main>
      </body>
      </html>
    `;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.setContent(htmlContent, { waitUntil: "networkidle" });

    await page.waitForFunction(() =>
      Array.from(document.images).every((img) => img.complete)
    );

    await page.emulateMedia({ media: "screen" });

    pdfPath = path.join(__dirname, `Atlas_Report_${Date.now()}.pdf`);

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "14mm",
        right: "12mm",
        bottom: "14mm",
        left: "12mm",
      },
    });

    console.log(`📄 [REPORT ENGINE] Executive PDF generated: ${pdfPath}`);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.REPORT_SENDER_EMAIL,
        pass: process.env.REPORT_GMAIL_APP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `"Atlas Intelligence" <${process.env.REPORT_SENDER_EMAIL}>`,
      to: managerEmail,
      subject: `📊 Atlas Intelligence Brief — ${new Date().toLocaleDateString()}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 620px; line-height: 1.55;">
          <h2 style="color: #0f172a; margin-bottom: 8px;">Atlas Intelligence Report Ready</h2>
          <p style="font-size: 14px; color: #475569;">
            Attached is the latest intelligence brief covering ${reportStats.games} game${
              reportStats.games === 1 ? "" : "s"
            }, ${reportStats.ads} mapped ad${reportStats.ads === 1 ? "" : "s"}, publisher data, install scale, ratings, and release metadata.
          </p>
          <div style="margin: 24px 0;">
            <a href="${SHEET_URL}" style="background: #2563eb; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 13px; display: inline-block;">View Live Google Sheets Dashboard</a>
          </div>
          <p style="font-size: 12px; color: #94a3b8;">Atlas Intelligence Node • Automated ASO Dispatch</p>
        </div>
      `,
      attachments: [
        {
          filename: `Atlas_Brief_${new Date().toISOString().split("T")[0]}.pdf`,
          path: pdfPath,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log("✅ [REPORT ENGINE] Executive email delivered successfully!");
  } catch (error) {
    console.error("❌ [REPORT ENGINE ERROR]:", error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error("Browser cleanup error:", error.message);
      }
    }

    if (pdfPath && fs.existsSync(pdfPath)) {
      try {
        fs.unlinkSync(pdfPath);
      } catch (error) {
        console.error("PDF cleanup error:", error.message);
      }
    }
  }
}

module.exports = { generateAndSendReport };
