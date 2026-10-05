const { Pool } = require('pg');

const gplayRaw = require('google-play-scraper');
const gplay = gplayRaw.default || gplayRaw;

const cleanConnectionString = (process.env.DATABASE_URL || '').split('?')[0];
const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: { rejectUnauthorized: false }
});

const STOP_WORDS = new Set([
  'a','about','above','after','again','against','all','also','am','an','and','any','are','as','at','be','because','been','before','being','below','between','both','but','by','can','could','did','do','does','doing','down','during','each','few','for','from','further','get','gets','got','had','has','have','having','he','her','here','hers','herself','him','himself','his','how','i','if','in','into','is','it','its','itself','just','me','more','most','my','myself','no','nor','not','now','of','off','on','once','only','or','other','our','ours','ourselves','out','over','own','same','she','should','so','some','such','than','that','the','their','theirs','them','themselves','then','there','these','they','this','those','through','to','too','under','until','up','very','was','we','were','what','when','where','which','while','who','whom','why','will','with','would','you','your','yours','yourself','yourselves',
  // Generic app-store wording is rarely competitively useful.
  'app','apps','game','games','play','playing','player','players','download','downloads','android','mobile','free','new','best','fun','enjoy','experience','features','feature'
]);

let schemaReady = false;
let schemaPromise = null;

function ensureSchema() {
  if (schemaReady) return Promise.resolve();
  if (schemaPromise) return schemaPromise;

  schemaPromise = pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS short_description TEXT;

    CREATE TABLE IF NOT EXISTS video_assets (
      id BIGSERIAL PRIMARY KEY,
      asset_key TEXT UNIQUE NOT NULL,
      asset_type TEXT NOT NULL,
      youtube_id TEXT,
      youtube_url TEXT,
      media_url TEXT,
      thumbnail_url TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      duration_seconds NUMERIC(10,3),
      source_host TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ad_video_assets (
      id BIGSERIAL PRIMARY KEY,
      creative_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      video_asset_id BIGINT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      transparency_url TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (creative_id, package_name, video_asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_assets_youtube_id
      ON video_assets(youtube_id)
      WHERE youtube_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_ad_video_assets_package
      ON ad_video_assets(package_name, last_seen_at DESC);
  `).then(() => {
    schemaReady = true;
  }).catch(error => {
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9'+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawWordCount(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ').filter(Boolean).length : 0;
}

function meaningfulTokens(value) {
  return normalizeText(value)
    .split(' ')
    .map(token => token.replace(/^'+|'+$/g, ''))
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function countTerms(value, minN = 1, maxN = 3) {
  const tokens = meaningfulTokens(value);
  const counts = new Map();

  for (let n = minN; n <= maxN; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      const term = tokens.slice(i, i + n).join(' ');
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }

  return counts;
}

function termDocumentSet(value) {
  return new Set(countTerms(value, 1, 3).keys());
}

function analyzeKeywords(target, corpusRows) {
  const shortDescription = String(target.short_description || '');
  const longDescription = String(target.description || '');
  const shortCounts = countTerms(shortDescription, 1, 3);
  const longCounts = countTerms(longDescription, 1, 3);
  const targetTerms = new Set([...shortCounts.keys(), ...longCounts.keys()]);
  const documentFrequency = new Map();

  for (const row of corpusRows) {
    if (Number(row.id) === Number(target.id)) continue;
    const terms = termDocumentSet(`${row.short_description || ''} ${row.description || ''}`);
    for (const term of terms) {
      if (!targetTerms.has(term)) continue;
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const corpusSize = Math.max(1, corpusRows.length);
  const scored = [];
  let maxScore = 0;

  for (const term of targetTerms) {
    const shortCount = shortCounts.get(term) || 0;
    const longCount = longCounts.get(term) || 0;
    const totalCount = shortCount + longCount;
    if (!totalCount) continue;

    const df = documentFrequency.get(term) || 0;
    const prevalence = df / corpusSize;
    const idf = Math.log((corpusSize + 1) / (df + 1)) + 1;
    const phraseBonus = term.includes(' ') ? (term.split(' ').length === 3 ? 1.3 : 1.16) : 1;
    const rawScore = totalCount * idf * phraseBonus;
    maxScore = Math.max(maxScore, rawScore);

    scored.push({
      term,
      shortCount,
      longCount,
      totalCount,
      corpusGamesUsing: df,
      corpusPrevalence: Number((prevalence * 100).toFixed(1)),
      rawScore,
      words: term.split(' ').length
    });
  }

  for (const row of scored) {
    row.distinctiveness = maxScore > 0
      ? Number(Math.min(100, (row.rawScore / maxScore) * 100).toFixed(1))
      : 0;
    delete row.rawScore;
  }

  const compare = (a, b) =>
    b.distinctiveness - a.distinctiveness ||
    b.totalCount - a.totalCount ||
    a.term.localeCompare(b.term);

  const phrases = scored.filter(row => row.words >= 2).sort(compare).slice(0, 50);
  const words = scored.filter(row => row.words === 1).sort(compare).slice(0, 50);
  const all = [...scored].sort(compare).slice(0, 100);

  return {
    shortDescription,
    longDescription,
    shortWordCount: rawWordCount(shortDescription),
    longWordCount: rawWordCount(longDescription),
    corpusGames: corpusRows.length,
    phrases,
    words,
    all
  };
}

async function refreshGameDescriptions(game) {
  try {
    const appData = await gplay.app({ appId: game.package_name, country: 'us', lang: 'en' });
    const shortDescription = appData?.summary || game.short_description || null;
    const longDescription = appData?.description || game.description || null;

    if (shortDescription || longDescription) {
      await pool.query(
        `UPDATE games
         SET short_description = COALESCE($2, short_description),
             description = COALESCE($3, description)
         WHERE id = $1`,
        [game.id, shortDescription, longDescription]
      );
    }

    return {
      ...game,
      short_description: shortDescription,
      description: longDescription
    };
  } catch {
    return game;
  }
}

async function getVideoLibrary() {
  await ensureSchema();

  const { rows } = await pool.query(`
    SELECT
      va.id AS video_asset_id,
      va.asset_key,
      va.asset_type,
      va.youtube_id,
      va.youtube_url,
      va.media_url,
      va.thumbnail_url,
      va.mime_type,
      va.width,
      va.height,
      va.duration_seconds,
      va.source_host,
      va.first_seen_at AS asset_first_seen_at,
      va.last_seen_at AS asset_last_seen_at,
      ava.creative_id,
      ava.package_name,
      ava.transparency_url,
      ava.first_seen_at AS relation_first_seen_at,
      ava.last_seen_at AS relation_last_seen_at,
      g.id AS game_id,
      g.title AS game_title,
      g.icon AS game_icon,
      g.rating AS game_rating,
      g.ratings_count AS game_ratings_count,
      g.installs AS game_installs,
      g.min_installs AS game_min_installs,
      g.category AS game_category,
      g.is_paid AS game_is_paid,
      g.price_text AS game_price_text,
      a.publisher_name,
      c.id AS competitor_id,
      c.name AS competitor_name
    FROM video_assets va
    JOIN ad_video_assets ava ON ava.video_asset_id = va.id
    LEFT JOIN games g ON g.package_name = ava.package_name
    LEFT JOIN account_games ag ON ag.game_id = g.id
    LEFT JOIN accounts a ON a.id = ag.account_id
    LEFT JOIN competitors c ON c.id = a.competitor_id
    ORDER BY va.last_seen_at DESC, ava.last_seen_at DESC
  `);

  const assets = new Map();

  for (const row of rows) {
    const id = Number(row.video_asset_id);
    if (!assets.has(id)) {
      assets.set(id, {
        id,
        assetKey: row.asset_key,
        type: row.asset_type,
        youtubeId: row.youtube_id || null,
        youtubeUrl: row.youtube_url || null,
        mediaUrl: row.media_url || null,
        thumbnailUrl: row.thumbnail_url || null,
        mimeType: row.mime_type || null,
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
        sourceHost: row.source_host || null,
        firstSeenAt: row.asset_first_seen_at,
        lastSeenAt: row.asset_last_seen_at,
        creatives: new Map(),
        games: new Map()
      });
    }

    const asset = assets.get(id);
    const creativeKey = row.creative_id;
    if (!asset.creatives.has(creativeKey)) {
      asset.creatives.set(creativeKey, {
        creativeId: row.creative_id,
        transparencyUrl: row.transparency_url || null,
        firstSeenAt: row.relation_first_seen_at,
        lastSeenAt: row.relation_last_seen_at
      });
    }

    const packageName = row.package_name;
    if (!asset.games.has(packageName)) {
      asset.games.set(packageName, {
        gameId: row.game_id == null ? null : Number(row.game_id),
        packageName,
        title: row.game_title || packageName,
        icon: row.game_icon || null,
        rating: row.game_rating == null ? null : Number(row.game_rating),
        ratingsCount: Number(row.game_ratings_count) || 0,
        installs: row.game_installs || null,
        minInstalls: Number(row.game_min_installs) || 0,
        category: row.game_category || null,
        isPaid: row.game_is_paid === true,
        priceText: row.game_price_text || null,
        publishers: new Set(),
        competitors: new Map()
      });
    }

    const game = asset.games.get(packageName);
    if (row.publisher_name) game.publishers.add(row.publisher_name);
    if (row.competitor_id && row.competitor_name) {
      game.competitors.set(Number(row.competitor_id), row.competitor_name);
    }

    const relationTime = new Date(row.relation_last_seen_at || 0).getTime();
    const currentTime = new Date(asset.lastSeenAt || 0).getTime();
    if (relationTime > currentTime) asset.lastSeenAt = row.relation_last_seen_at;
  }

  return [...assets.values()].map(asset => ({
    ...asset,
    adCount: asset.creatives.size,
    creativeIds: [...asset.creatives.keys()],
    creatives: [...asset.creatives.values()],
    games: [...asset.games.values()].map(game => ({
      ...game,
      publishers: [...game.publishers],
      competitors: [...game.competitors.entries()].map(([id, name]) => ({ id, name }))
    }))
  }));
}

function registerIntelligenceFeatures(app) {
  if (!app) throw new Error('Atlas Express app was not captured.');

  ensureSchema().catch(error => {
    console.error('⚠️ [Intelligence] Schema initialization failed:', error.message);
  });

  app.get('/api/video-library', async (_req, res) => {
    try {
      const items = await getVideoLibrary();
      res.set('Cache-Control', 'no-store');
      res.json(items);
    } catch (error) {
      console.error('Video library fetch failed:', error);
      res.status(500).json({ error: 'Unable to load video library.' });
    }
  });

  app.get('/api/video-assets/:id/download', async (req, res) => {
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid video asset ID.' });

      const { rows } = await pool.query(
        'SELECT media_url, mime_type, youtube_url FROM video_assets WHERE id = $1 LIMIT 1',
        [id]
      );
      const asset = rows[0];
      if (!asset) return res.status(404).json({ error: 'Video asset not found.' });
      if (!asset.media_url) {
        return res.status(409).json({
          error: asset.youtube_url
            ? 'This is a YouTube-backed creative. Open the permanent YouTube link instead.'
            : 'No direct media URL was captured for this asset.'
        });
      }

      const upstream = await fetch(asset.media_url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
        }
      });

      if (!upstream.ok || !upstream.body) {
        return res.status(410).json({ error: 'The captured media URL has expired or is no longer accessible. Rescan the advertiser to refresh it.' });
      }

      res.set('Content-Type', upstream.headers.get('content-type') || asset.mime_type || 'video/mp4');
      const length = upstream.headers.get('content-length');
      if (length) res.set('Content-Length', length);
      res.set('Content-Disposition', `attachment; filename="atlas-video-${id}.mp4"`);
      res.set('Cache-Control', 'no-store');

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('Video download proxy failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Unable to download this video asset.' });
      else res.end();
    }
  });

  app.get('/api/games/:id/keywords', async (req, res) => {
    try {
      await ensureSchema();
      const gameId = Number(req.params.id);
      if (!Number.isInteger(gameId) || gameId <= 0) return res.status(400).json({ error: 'Invalid game ID.' });

      const { rows } = await pool.query(
        `SELECT id, package_name, title, short_description, description
         FROM games
         WHERE id = $1
         LIMIT 1`,
        [gameId]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Game not found.' });

      let game = rows[0];
      if (!game.short_description) game = await refreshGameDescriptions(game);

      const { rows: corpus } = await pool.query(
        `SELECT id, short_description, description
         FROM games
         WHERE COALESCE(description, '') <> '' OR COALESCE(short_description, '') <> ''`
      );

      const analysis = analyzeKeywords(game, corpus);
      res.set('Cache-Control', 'no-store');
      res.json({
        game: {
          id: Number(game.id),
          packageName: game.package_name,
          title: game.title
        },
        ...analysis
      });
    } catch (error) {
      console.error('Keyword analysis failed:', error);
      res.status(500).json({ error: 'Unable to analyze game keywords.' });
    }
  });
}

module.exports = {
  registerIntelligenceFeatures,
  analyzeKeywords,
  getVideoLibrary
};