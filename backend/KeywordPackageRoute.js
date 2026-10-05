const { Pool } = require('pg');
const { analyzeKeywords } = require('./AtlasIntelligenceFeatures');

const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

function registerKeywordPackageRoute(app) {
  app.get('/api/keywords', async (req, res) => {
    const packageName = String(req.query.packageName || '').trim().toLowerCase();
    if (!packageName || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(packageName)) {
      return res.status(400).json({ error: 'A valid Android package name is required.' });
    }

    try {
      await pool.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS short_description TEXT');

      const { rows } = await pool.query(
        `SELECT id, package_name, title, short_description, description
         FROM games
         WHERE LOWER(package_name) = $1
         LIMIT 1`,
        [packageName]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'This package is not currently stored in the Atlas game directory.' });
      }

      let game = rows[0];

      // Atlas historically stored only the long description. Fill the short
      // description lazily the first time Keyword Intelligence is opened.
      if (!game.short_description) {
        try {
          const appData = await gplay.app({ appId: game.package_name, country: 'us', lang: 'en' });
          const shortDescription = appData?.summary || null;
          const longDescription = appData?.description || game.description || null;
          await pool.query(
            `UPDATE games
             SET short_description = COALESCE($2, short_description),
                 description = COALESCE($3, description)
             WHERE id = $1`,
            [game.id, shortDescription, longDescription]
          );
          game = {
            ...game,
            short_description: shortDescription || game.short_description,
            description: longDescription
          };
        } catch {}
      }

      const { rows: corpus } = await pool.query(
        `SELECT id, short_description, description
         FROM games
         WHERE COALESCE(description, '') <> '' OR COALESCE(short_description, '') <> ''`
      );

      const analysis = analyzeKeywords(game, corpus);
      res.set('Cache-Control', 'no-store');
      return res.json({
        game: {
          id: Number(game.id),
          packageName: game.package_name,
          title: game.title
        },
        ...analysis
      });
    } catch (error) {
      console.error('Package keyword analysis failed:', error);
      return res.status(500).json({ error: 'Unable to analyze game keywords.' });
    }
  });
}

module.exports = { registerKeywordPackageRoute };
