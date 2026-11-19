const { resolveEffectivePricing } = require('./PriceClassification');

const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 30;
let summaryVersion = Date.now();
const summaryCache = new Map();
const inflightQueries = new Map();

const VALID_WINDOWS = new Map([
  ['7d', 7],
  ['14d', 14],
  ['30d', 30],
  ['90d', 90]
]);

const PLAY_ATTRIBUTE_TAGS = new Set([
  'single player',
  'multiplayer',
  'offline',
  'online',
  'stylized',
  'realistic',
  'low poly',
  'abstract',
  'cartoon',
  'anime',
  'pixelated',
  '2d',
  '3d',
  'competitive multiplayer',
  'co-op',
  'local multiplayer',
  'hand-drawn',
  'comic'
]);

const APP_CATEGORIES = new Set([
  'tools',
  'productivity',
  'personalization',
  'photography',
  'maps & navigation',
  'communication',
  'entertainment',
  'lifestyle',
  'social',
  'finance',
  'health & fitness',
  'education',
  'music & audio',
  'music',
  'art & design',
  'shopping',
  'weather',
  'video players & editors',
  'books & reference',
  'business',
  'travel & local',
  'news & magazines',
  'utilities',
  'auto & vehicles',
  'house & home',
  'medical',
  'food & drink',
  'parenting',
  'events',
  'dating',
  'beauty',
  'libraries & demo',
  'comics'
]);

const FUNCTION_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'be', 'am', 'my', 'your', 'our',
  'me', 'you', 'it', 'its', 'this', 'that', 'these', 'those', 'vs', 'into',
  'i', 'we', 'he', 'she', 'they', 'no', 'not', 'so', 'up', 'out'
]);

const FORMAT_NOISE_WORDS = new Set([
  '3d', '2d', 'hd', '4k', 'pro', 'vip', 'lite', 'apk', 'mod', 'plus', 'max',
  'ultra', 'mega', 'super', 'mini', 'tiny', 'pocket', 'mobile', 'android',
  'v2', '2023', '2024', '2025', '2026', 'new', 'best', 'top', 'free', 'real',
  'true', 'pure', 'full', 'open', 'all', 'one', 'two', '100'
]);

const BOILERPLATE_SINGLE_WORDS = new Set([
  'game', 'simulator', 'sim', 'offline', 'online', 'funny', 'fun', 'kid',
  'kids', 'world', 'city', 'life', 'story', 'adventure', 'challenge', 'battle',
  'craft', 'maker', 'builder', 'tycoon', 'idle', 'rush', 'dash', 'run',
  'runner', 'puzzle', 'action', 'casual', 'classic', 'ultimate', 'crazy',
  'modern', 'extreme', 'grand', 'royal', 'play', 'player', 'driving',
  'driver', 'drive', 'car', 'bus', 'truck', 'coach', 'taxi', 'bike', 'moto',
  'racing', 'race', 'parking', 'police', 'cop', 'survival', 'survive',
  'escape', 'merge', 'sort', 'coloring', 'color', 'paint', 'painting',
  'match', 'block', 'shooter', 'shoot', 'shooting', 'fight', 'fighting',
  'war', 'gun', 'sniper', 'zombie', 'monster', 'animal', 'pet', 'cat', 'dog',
  'baby', 'girl', 'boy', 'school', 'house', 'home', 'shop', 'store',
  'station', 'cooking', 'kitchen', 'food', 'doctor', 'hospital', 'salon',
  'dress', 'fashion', 'makeup', 'beauty', 'makeover', 'clean', 'cleaner',
  'scanner', 'scan', 'editor', 'photo', 'picture', 'video', 'music',
  'wallpaper', 'sticker', 'phone', 'smart', 'tracker', 'finder',
  'identifier', 'recovery', 'manager', 'studio', 'hero', 'king', 'legend',
  'master', 'hide', 'seek', 'tap', 'loop', 'art', 'cloud', 'series', 'shorts',
  'virtual', 'family', 'party', 'club', 'quest', 'land', 'town', 'village',
  'solve', 'solving'
]);

// Allow distinctive viral framing stems like "i am <X>" or "be a <X>"
const ALLOW_GRAM_PREFIXES = new Set(['i', 'be']);
const ALLOW_GRAM_SECOND = new Set(['am', 'a']);

function invalidateMarketSummaryCache() {
  summaryVersion = Date.now();
  summaryCache.clear();
}

function parseDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'unknown') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addDays(dateKey, deltaDays) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function dayDiff(laterKey, earlierKey) {
  const a = new Date(`${laterKey}T00:00:00Z`).getTime();
  const b = new Date(`${earlierKey}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86400000);
}

function parseSubcategories(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function resolveGameClassification(game = {}) {
  const rawCategory = String(game.category || '').trim();
  const subRaw = parseSubcategories(game.subcategories);

  const meaningfulTags = [];
  const seen = new Set();
  const pushTag = (val) => {
    const clean = String(val || '').trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (lower === 'game' || lower === 'games') return;
    if (PLAY_ATTRIBUTE_TAGS.has(lower)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    meaningfulTags.push(clean);
  };

  for (const tag of subRaw) pushTag(tag);
  if (rawCategory && !['game', 'games', 'uncategorized'].includes(rawCategory.toLowerCase())) {
    pushTag(rawCategory);
  }

  const primaryGenre = meaningfulTags[0] || (rawCategory && rawCategory.toLowerCase() !== 'game' ? rawCategory : 'Uncategorized');
  const subGenres = meaningfulTags.slice(1);

  const isExplicitApp =
    APP_CATEGORIES.has(primaryGenre.toLowerCase()) ||
    APP_CATEGORIES.has(rawCategory.toLowerCase()) ||
    meaningfulTags.some((t) => APP_CATEGORIES.has(t.toLowerCase()));

  return {
    primaryGenre,
    subGenres,
    allGenres: meaningfulTags.length > 0 ? meaningfulTags : [primaryGenre],
    appType: isExplicitApp ? 'app' : 'game'
  };
}

function normalizeDisplayName(row) {
  const disp = String(row.publisher_display_name || '').trim();
  if (disp) return disp;
  return String(row.publisher_name || '').trim() || 'Unknown Publisher';
}

function deduplicateGames(rows = []) {
  const byPkg = new Map();

  for (const row of rows) {
    const pkg = String(row.package_name || '').trim();
    if (!pkg) continue;

    let entry = byPkg.get(pkg);
    if (!entry) {
      const effective = resolveEffectivePricing(row);
      const cls = resolveGameClassification(row);
      const isSuspended = Boolean(row.is_suspended) || row.release_status === 'SUSPENDED';
      const relStatus = isSuspended
        ? 'SUSPENDED'
        : (row.release_status || 'LIVE');
      const releaseDate = parseDateKey(row.release_date) || parseDateKey(row.released);
      const firstSeenDate = parseDateKey(row.first_seen_at);

      entry = {
        id: row.id ? Number(row.id) : null,
        package_name: pkg,
        title: String(row.title || pkg).trim(),
        category: row.category || null,
        subcategories: parseSubcategories(row.subcategories),
        primaryGenre: cls.primaryGenre,
        subGenres: cls.subGenres,
        allGenres: cls.allGenres,
        appType: cls.appType,
        icon: row.icon || null,
        rating: row.rating != null ? Number(row.rating) : null,
        ratings_count: Number(row.ratings_count) || 0,
        review_count: Number(row.ratings_count) || 0,
        real_installs: row.real_installs != null ? Number(row.real_installs) : null,
        min_installs: Number(row.min_installs) || 0,
        installs: row.installs || null,
        installs_delta_1d: Number(row.installs_delta_1d) || 0,
        installs_avg_daily_7d: Number(row.installs_avg_daily_7d) || 0,
        installs_total_7d: Number(row.installs_total_7d) || 0,
        release_date: releaseDate,
        first_seen_date: firstSeenDate,
        first_seen_at: row.first_seen_at || firstSeenDate,
        first_campaign_date: parseDateKey(row.first_campaign_seen_at),
        pricing: effective.pricing,
        price: row.price != null ? Number(row.price) : null,
        price_text: row.price_text || null,
        price_status: row.price_status || (effective.pricing === 'paid' ? 'PAID' : 'FREE'),
        is_manual_price: effective.is_manual,
        release_status: relStatus,
        is_suspended: isSuspended,
        suspended_at: row.suspended_at || null,
        campaign_active: isSuspended ? false : (Boolean(row.campaign_active) || Number(row.ad_count) > 0),
        has_campaign: isSuspended ? false : (Boolean(row.campaign_active) || Number(row.ad_count) > 0),
        campaign_source: row.campaign_source || (Number(row.ad_count) > 0 ? 'transparency_center' : null),
        ad_count: Number(row.ad_count) || 0,
        developer_id: row.developer_id || null,
        developer_name: row.developer_name || null,
        publisher_id: row.publisher_id ? Number(row.publisher_id) : null,
        publisher_name: row.publisher_name || null,
        publisher_display: row.publisher_id ? normalizeDisplayName(row) : (row.publisher_name || null),
        competitor_name: null,
        competitor_names: [],
        publishers: [],
        competitors: [],
        _pubKeys: new Set(),
        _compKeys: new Set(),
        _listIds: new Set(),
        _groupIds: new Set()
      };
      byPkg.set(pkg, entry);
    }

    const pubId = row.publisher_id ? Number(row.publisher_id) : null;
    const pubDisp = pubId ? normalizeDisplayName(row) : (row.developer_name || null);
    if (pubId && !entry._pubKeys.has(pubId)) {
      entry._pubKeys.add(pubId);
      entry.publishers.push({
        id: pubId,
        name: pubDisp,
        rawName: row.publisher_name || pubDisp
      });
    }

    const listId = row.list_id ? Number(row.list_id) : null;
    const compId = row.competitor_id ? Number(row.competitor_id) : null;
    const compName = row.list_name || row.competitor_name || null;
    const compKey = compId
      ? `comp:${compId}`
      : listId
      ? `list:${listId}`
      : pubId
      ? `pub:${pubId}`
      : null;

    if (listId) entry._listIds.add(listId);
    if (row.group_id) entry._groupIds.add(Number(row.group_id));

    if (compKey && !entry._compKeys.has(compKey)) {
      entry._compKeys.add(compKey);
      entry.competitors.push({
        key: compKey,
        competitorId: compId,
        listId,
        name: compName || pubDisp || 'Unassigned'
      });
      if (compName && !entry.competitor_names.includes(compName)) {
        entry.competitor_names.push(compName);
      }
      if (!entry.competitor_name && compName) {
        entry.competitor_name = compName;
      }
    }
  }

  return [...byPkg.values()];
}

function getEffectiveDate(game, dateBasis = 'release_date') {
  return dateBasis === 'first_seen_at'
    ? (game.first_seen_date || null)
    : (game.release_date || null);
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function tokenizeTitle(title) {
  const cleaned = String(title || '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];
  return cleaned
    .split(' ')
    .map((raw) => {
      if (
        raw.length >= 5 &&
        raw.endsWith('s') &&
        !/(ss|us|is|os|as|news|kids|apps|lens|plus)$/i.test(raw)
      ) {
        return raw.slice(0, -1);
      }
      if (raw === 'games') return 'game';
      if (raw === 'apps') return 'app';
      if (raw === 'cars') return 'car';
      if (raw === 'kids') return 'kid';
      return raw;
    })
    .filter((t) => t.length >= 1 && (/[a-z]/.test(t) || t.length >= 2));
}

function isPureNoiseToken(token) {
  return FUNCTION_STOPWORDS.has(token) || FORMAT_NOISE_WORDS.has(token) || /^\d+$/.test(token);
}

function isAnyBoilerplateToken(token) {
  return isPureNoiseToken(token) || BOILERPLATE_SINGLE_WORDS.has(token);
}

function extractTitleNgrams(title) {
  const tokens = tokenizeTitle(title);
  if (tokens.length === 0) return [];

  const found = new Map(); // term -> { term, wordCount, distinctiveCount }
  const recordTerm = (words) => {
    const term = words.join(' ');
    if (found.has(term)) return;
    const distinctiveCount = words.filter((w) => !isAnyBoilerplateToken(w)).length;
    found.set(term, {
      term,
      wordCount: words.length,
      distinctiveCount
    });
  };

  // Standalone 1-grams (strict: never stopwords, format noise, or generic boilerplate)
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (isAnyBoilerplateToken(token)) continue;
    recordTerm([token]);
  }

  // 2-grams and 3-grams
  for (let size = 2; size <= 3; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const slice = tokens.slice(i, i + size);
      if (slice.some((w) => /^\d+$/.test(w) || FORMAT_NOISE_WORDS.has(w))) continue;

      const allowIntro =
        size === 3 && ALLOW_GRAM_PREFIXES.has(slice[0]) && ALLOW_GRAM_SECOND.has(slice[1]);
      if (!allowIntro && FUNCTION_STOPWORDS.has(slice[0])) continue;
      if (FUNCTION_STOPWORDS.has(slice[slice.length - 1])) continue;
      if (slice.some((w) => w.length < 2 && !allowIntro)) continue;

      const distinctiveCount = slice.filter((w) => !isAnyBoilerplateToken(w)).length;
      // Require at least one non-boilerplate word OR a non-trivial 2+ word combination
      if (distinctiveCount === 0 && size < 2) continue;
      recordTerm(slice);
    }
  }

  return [...found.values()];
}

function jaccardTokenSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function detectRepeatedTitleVariations(games) {
  if (!Array.isArray(games) || games.length < 3) return false;
  const tokenSets = games.map((g) => tokenizeTitle(g.title).filter((w) => !isPureNoiseToken(w)));
  let similarPairs = 0;
  let totalPairs = 0;
  const sample = tokenSets.slice(0, 12);
  for (let i = 0; i < sample.length; i += 1) {
    for (let j = i + 1; j < sample.length; j += 1) {
      totalPairs += 1;
      if (jaccardTokenSimilarity(sample[i], sample[j]) >= 0.65) {
        similarPairs += 1;
      }
    }
  }
  return totalPairs > 0 && similarPairs / totalPairs >= 0.5;
}

function toCompactGameSummary(g, historyByPkg = new Map(), windowDays = 30) {
  const hist = historyByPkg.get(g.package_name);
  const netGainWindow = hist ? hist.curGain : 0;
  const dailyVelocity = hist && hist.curDays > 0
    ? Math.round(hist.curDailyRate)
    : Math.max(0, Number(g.installs_delta_1d || g.installs_avg_daily_7d || 0));

  return {
    id: g.id,
    package_name: g.package_name,
    title: g.title,
    icon: g.icon,
    primaryGenre: g.primaryGenre,
    appType: g.appType,
    publisher_name: g.publisher_display || g.publisher_name,
    competitor_name: g.competitor_name || g.competitor_names?.[0] || null,
    competitor_names: g.competitor_names || [],
    release_date: g.release_date,
    first_seen_at: g.first_seen_at,
    real_installs: g.real_installs != null ? Number(g.real_installs) : Number(g.min_installs || 0),
    installs_delta_1d: dailyVelocity,
    window_install_gain: netGainWindow,
    rating: g.rating,
    ratings_count: g.ratings_count,
    pricing: g.pricing,
    price: g.price,
    price_text: g.price_text,
    price_status: g.price_status,
    has_campaign: g.has_campaign,
    campaign_source: g.campaign_source,
    is_suspended: g.is_suspended,
    release_status: g.release_status
  };
}

function formatTrendLabel(term) {
  return term
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() === 'AI' ? 'AI' : w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function detectTitleTrends({
  games = [],
  windowDays = 30,
  dateBasis = 'release_date',
  now = new Date(),
  historyByPkg = new Map()
}) {
  const todayKey = parseDateKey(now);
  const windowStart = addDays(todayKey, -(windowDays - 1));
  const last7Start = addDays(todayKey, -6);
  const prev7Start = addDays(todayKey, -13);

  const recentGames = [];
  const baselineGames = [];

  for (const g of games) {
    if (g.is_suspended) continue;
    const dt = getEffectiveDate(g, dateBasis);
    if (!dt) continue;
    if (dt >= windowStart && dt <= todayKey) {
      recentGames.push({ game: g, dateKey: dt });
    } else if (dt < windowStart) {
      baselineGames.push({ game: g, dateKey: dt });
    }
  }

  const recentTotal = Math.max(1, recentGames.length);
  const baselineTotal = Math.max(1, baselineGames.length);

  const termBuckets = new Map();

  for (const { game, dateKey } of recentGames) {
    const terms = extractTitleNgrams(game.title);
    for (const meta of terms) {
      let bucket = termBuckets.get(meta.term);
      if (!bucket) {
        bucket = {
          term: meta.term,
          wordCount: meta.wordCount,
          distinctiveCount: meta.distinctiveCount,
          recentMatches: [],
          baselineMatches: [],
          pkgSet: new Set(),
          competitorMap: new Map(), // compKey -> { key, name, pkgs: Set, pubs: Set }
          publisherSet: new Set(),
          last7dCount: 0,
          prev7dCount: 0,
          firstDetectedAt: dateKey
        };
        termBuckets.set(meta.term, bucket);
      }

      if (bucket.pkgSet.has(game.package_name)) continue;
      bucket.pkgSet.add(game.package_name);
      bucket.recentMatches.push({ game, dateKey });
      if (dateKey < bucket.firstDetectedAt) bucket.firstDetectedAt = dateKey;
      if (dateKey >= last7Start) bucket.last7dCount += 1;
      else if (dateKey >= prev7Start && dateKey < last7Start) bucket.prev7dCount += 1;

      for (const pub of game.publishers || []) {
        bucket.publisherSet.add(pub.id);
      }
      const comps = (game.competitors && game.competitors.length > 0)
        ? game.competitors
        : [{ key: `pub:${game.publisher_id || game.package_name}`, name: game.publisher_display || 'Unknown' }];

      for (const c of comps) {
        let compEntry = bucket.competitorMap.get(c.key);
        if (!compEntry) {
          compEntry = { key: c.key, name: c.name, count: 0, pubIds: new Set() };
          bucket.competitorMap.set(c.key, compEntry);
        }
        compEntry.count += 1;
        for (const pub of game.publishers || []) compEntry.pubIds.add(pub.id);
      }
    }
  }

  // Match baseline historical games ONLY for terms seen recently (keeps memory/CPU O(recent terms))
  for (const { game, dateKey } of baselineGames) {
    const terms = extractTitleNgrams(game.title);
    for (const meta of terms) {
      const bucket = termBuckets.get(meta.term);
      if (!bucket) continue;
      bucket.baselineMatches.push({ game, dateKey });
    }
  }

  const scored = [];
  for (const b of termBuckets.values()) {
    const recentCount = b.recentMatches.length;
    if (recentCount < 2) continue;

    // Require at least one distinctive non-boilerplate word for trending waves,
    // OR 3+ distinct competitors for multi-word gameplay concepts
    const distinctCompetitors = b.competitorMap.size;
    if (b.distinctiveCount === 0 && distinctCompetitors < 3) continue;

    const baselineCount = b.baselineMatches.length;
    const distinctPublishers = Math.max(1, b.publisherSet.size);

    const competitorBreakdown = [...b.competitorMap.values()]
      .map((c) => ({
        competitorName: c.name,
        titleCount: c.count,
        publisherCount: c.pubIds.size
      }))
      .sort((a, c) => c.titleCount - a.titleCount || a.competitorName.localeCompare(c.competitorName));

    const maxCompShare = competitorBreakdown[0]
      ? competitorBreakdown[0].titleCount / recentCount
      : 1;
    const repeatedVariations =
      (recentCount >= 3 && maxCompShare > 0.65 && detectRepeatedTitleVariations(b.recentMatches.map((m) => m.game))) ||
      (distinctCompetitors === 1 && recentCount >= 3);

    const recentRate = recentCount / recentTotal;
    const baselineRate = baselineCount / baselineTotal;
    const burstRatio = Number((recentRate / (baselineRate + 0.0015)).toFixed(2));

    const breadthWeight = Math.pow(distinctCompetitors, 1.45) * Math.log2(recentCount + 1);
    const phraseBonus = b.wordCount >= 2 ? 1.35 : 1.0;
    const noveltyFactor = baselineCount === 0
      ? 2.4
      : Math.min(2.2, Math.max(0.55, Math.log2(burstRatio + 1) / 1.5));
    const spamPenalty = distinctCompetitors === 1 && repeatedVariations ? 0.35 : 1.0;

    const burstScore = Number((breadthWeight * phraseBonus * noveltyFactor * spamPenalty * 10).toFixed(2));

    let status = 'established';
    if (distinctCompetitors < 2) {
      status = 'single_competitor';
    } else if (baselineCount === 0 || (baselineCount <= 1 && burstRatio >= 6)) {
      status = 'new_wave';
    } else if (burstRatio >= 2.2) {
      status = 'emerging';
    }

    const matchingGames = b.recentMatches
      .sort((x, y) => y.dateKey.localeCompare(x.dateKey) || (Number(y.game.real_installs || 0) - Number(x.game.real_installs || 0)))
      .map((m) => toCompactGameSummary(m.game, historyByPkg, windowDays));

    const baselineExamples = b.baselineMatches
      .slice(0, 3)
      .map((m) => toCompactGameSummary(m.game, historyByPkg, windowDays));

    const combinedInstalls = matchingGames.reduce((acc, g) => acc + Number(g.real_installs || 0), 0);
    const combinedDailyDelta = matchingGames.reduce((acc, g) => acc + Number(g.installs_delta_1d || 0), 0);

    scored.push({
      phrase: b.term,
      displayPhrase: formatTrendLabel(b.term),
      wordCount: b.wordCount,
      distinctiveCount: b.distinctiveCount,
      status,
      matchingGamesCount: recentCount,
      baselineGamesCount: baselineCount,
      distinctCompetitors,
      distinctPublishers,
      firstDetectedAt: b.firstDetectedAt,
      firstDetectedDaysAgo: Math.max(0, dayDiff(todayKey, b.firstDetectedAt)),
      last7dCount: b.last7dCount,
      prev7dCount: b.prev7dCount,
      burstRatio,
      burstScore,
      hasRepeatedVariations: repeatedVariations,
      combinedInstalls,
      combinedDailyDelta,
      competitorBreakdown,
      matchingGames: matchingGames.slice(0, 12),
      baselineExamples
    });
  }

  // Collapse sub-terms (e.g. "gugu", "gaga") under longer phrases ("gugu gaga")
  // when >= 75% of recent matched packages overlap and longer phrase has >= competitor spread.
  const byLengthDesc = [...scored].sort(
    (a, b) => b.wordCount - a.wordCount || b.distinctCompetitors - a.distinctCompetitors || b.burstScore - a.burstScore
  );

  const kept = [];
  const keptPkgSets = [];

  for (const item of byLengthDesc) {
    const pkgs = new Set(item.matchingGames.map((g) => g.package_name));
    let subsumed = false;

    for (let i = 0; i < kept.length; i += 1) {
      const parent = kept[i];
      if (parent.wordCount <= item.wordCount) continue;
      if (!parent.phrase.includes(item.phrase)) continue;

      const parentPkgs = keptPkgSets[i];
      let overlap = 0;
      for (const p of pkgs) {
        if (parentPkgs.has(p)) overlap += 1;
      }
      const overlapRatio = pkgs.size > 0 ? overlap / pkgs.size : 0;
      const threshold = parent.wordCount >= 2 && item.wordCount === 1 ? 0.66 : 0.75;
      if (overlapRatio >= threshold && parent.distinctCompetitors >= item.distinctCompetitors) {
        subsumed = true;
        break;
      }
    }

    if (!subsumed) {
      kept.push(item);
      keptPkgSets.push(pkgs);
    }
  }

  const multiCompetitor = kept.filter((t) => t.distinctCompetitors >= 2);
  const singleCompetitor = kept
    .filter((t) => t.distinctCompetitors < 2 && t.distinctiveCount > 0)
    .sort((a, b) => b.matchingGamesCount - a.matchingGamesCount || b.combinedDailyDelta - a.combinedDailyDelta)
    .slice(0, 15);

  const emerging = [...multiCompetitor]
    .sort((a, b) => {
      const rank = { new_wave: 3, emerging: 2, established: 1 };
      return (
        (rank[b.status] || 0) - (rank[a.status] || 0) ||
        b.burstScore - a.burstScore ||
        b.distinctCompetitors - a.distinctCompetitors ||
        b.matchingGamesCount - a.matchingGamesCount
      );
    })
    .slice(0, 25);

  const repeated = [...multiCompetitor]
    .sort(
      (a, b) =>
        b.distinctCompetitors - a.distinctCompetitors ||
        b.matchingGamesCount - a.matchingGamesCount ||
        b.combinedDailyDelta - a.combinedDailyDelta
    )
    .slice(0, 25);

  return {
    recentTitlesAnalyzed: recentGames.length,
    baselineTitlesAnalyzed: baselineGames.length,
    emergingCount: emerging.filter((t) => t.status === 'new_wave' || t.status === 'emerging').length,
    emerging,
    repeated,
    singleCompetitor
  };
}

function buildInstallHistoryMap(historyRows = []) {
  const byPkg = new Map();
  for (const r of historyRows) {
    const pkg = String(r.package_name || '').trim();
    if (!pkg) continue;
    const curDays = Number(r.cur_days) || 0;
    const prevDays = Number(r.prev_days) || 0;
    const curSpan = Math.max(1, Number(r.cur_span_days) || 1);
    const prevSpan = Math.max(1, Number(r.prev_span_days) || 1);

    let curGain = 0;
    let curDailyRate = 0;
    let hasVerifiedCur = false;
    if (curDays >= 2 && r.cur_last_installs != null && r.cur_first_installs != null) {
      hasVerifiedCur = true;
      curGain = Number(r.cur_last_installs) - Number(r.cur_first_installs);
      curDailyRate = curGain / curSpan;
    }

    let prevGain = 0;
    let prevDailyRate = 0;
    let hasVerifiedPrev = false;
    if (prevDays >= 2 && r.prev_last_installs != null && r.prev_first_installs != null) {
      hasVerifiedPrev = true;
      prevGain = Number(r.prev_last_installs) - Number(r.prev_first_installs);
      prevDailyRate = prevGain / prevSpan;
    }

    byPkg.set(pkg, {
      curDays,
      prevDays,
      hasVerifiedCur,
      hasVerifiedPrev,
      curGain,
      prevGain,
      curDailyRate,
      prevDailyRate
    });
  }
  return byPkg;
}

function computeHistoricalCoverage(covRow, windowDays, verifiedBothCount = 0) {
  const totalDays = Number(covRow?.total_days) || 0;
  const minDate = covRow?.min_dt || null;
  const maxDate = covRow?.max_dt || null;
  const curDaysCovered = Number(covRow?.cur_days_covered) || 0;
  const prevDaysCovered = Number(covRow?.prev_days_covered) || 0;

  let comparisonStatus = 'insufficient';
  let comparisonNote = `Live multi-scrape telemetry spans ${totalDays} distinct scrape date${totalDays === 1 ? '' : 's'}${minDate ? ` (since ${minDate})` : ''}. Wait for re-scans across the prior ${windowDays}d window before comparing period-over-period growth.`;

  if (prevDaysCovered >= Math.ceil(windowDays * 0.6) && verifiedBothCount >= 10) {
    comparisonStatus = 'full';
    comparisonNote = `Full ${windowDays}d baseline available (${curDaysCovered} current scrape days vs ${prevDaysCovered} prior scrape days; ${verifiedBothCount} multi-scan matched titles).`;
  } else if (prevDaysCovered >= 3 && verifiedBothCount >= 5) {
    comparisonStatus = 'partial';
    comparisonNote = `Partial baseline: ${verifiedBothCount} titles have multi-day scans in both windows (${prevDaysCovered}/${windowDays} prior scrape days since ${minDate}).`;
  }

  return {
    totalSnapshotDays: totalDays,
    minSnapshotDate: minDate,
    maxSnapshotDate: maxDate,
    currentWindowDaysCovered: curDaysCovered,
    priorWindowDaysCovered: prevDaysCovered,
    verifiedMultiScanBothWindows: verifiedBothCount,
    comparisonStatus,
    comparisonNote
  };
}

function aggregateGenreBuckets({
  games = [],
  historyByPkg = new Map(),
  coverage,
  windowDays = 30,
  dateBasis = 'release_date',
  todayKey,
  mode = 'primary' // 'primary' | 'subgenre'
}) {
  const windowStart = addDays(todayKey, -(windowDays - 1));
  const prevStart = addDays(todayKey, -(windowDays * 2 - 1));
  const buckets = new Map();

  for (const g of games) {
    const labels = mode === 'primary'
      ? [g.primaryGenre || 'Uncategorized']
      : (g.subGenres || []);
    if (labels.length === 0) continue;

    const hist = historyByPkg.get(g.package_name);
    const hasCurSnapshot = Boolean(hist && hist.hasVerifiedCur);
    const hasBothSnapshots = Boolean(hist && hist.hasVerifiedCur && hist.hasVerifiedPrev);
    const curDailyRate = hasCurSnapshot ? hist.curDailyRate : 0;
    const curInstallGain = hasCurSnapshot ? hist.curGain : 0;

    const effDate = getEffectiveDate(g, dateBasis);
    const isRecentRelease = Boolean(effDate && effDate >= windowStart && effDate <= todayKey);
    const isPrevRelease = Boolean(effDate && effDate >= prevStart && effDate < windowStart);

    for (const genreName of labels) {
      if (mode === 'subgenre' && genreName === g.primaryGenre) continue;
      let b = buckets.get(genreName);
      if (!b) {
        b = {
          genre: genreName,
          trackedGamesCount: 0,
          activeTelemetryCount: 0,
          snapshotBackedCount: 0,
          matchedBaselineCount: 0,
          totalInstallGrowth: 0,
          totalDailyVelocity: 0,
          matchedCurDailySum: 0,
          matchedPrevDailySum: 0,
          dailyRates: [],
          growingGamesCount: 0,
          decliningGamesCount: 0,
          newReleasesCount: 0,
          prevReleasesCount: 0,
          competitorKeys: new Set(),
          publisherIds: new Set(),
          gamesList: [],
          recentReleasesList: []
        };
        buckets.set(genreName, b);
      }

      b.trackedGamesCount += 1;
      if (!g.is_suspended && (hasCurSnapshot || curDailyRate > 0)) {
        b.activeTelemetryCount += 1;
        if (hasCurSnapshot) b.snapshotBackedCount += 1;
        b.totalInstallGrowth += curInstallGain;
        b.totalDailyVelocity += curDailyRate;
        b.dailyRates.push(curDailyRate);

        if (hasBothSnapshots) {
          b.matchedBaselineCount += 1;
          b.matchedCurDailySum += hist.curDailyRate;
          b.matchedPrevDailySum += hist.prevDailyRate;
        }

        const isDeclining =
          curInstallGain < 0 ||
          (hasBothSnapshots && hist.prevDailyRate >= 20 && hist.curDailyRate <= hist.prevDailyRate * 0.8);
        const isGrowing =
          curDailyRate >= 25 &&
          (!hasBothSnapshots || hist.curDailyRate >= hist.prevDailyRate * 0.9);

        if (isDeclining) b.decliningGamesCount += 1;
        else if (isGrowing) b.growingGamesCount += 1;
      }

      if (isRecentRelease) {
        b.newReleasesCount += 1;
        for (const c of g.competitors || []) b.competitorKeys.add(c.key);
        for (const p of g.publishers || []) b.publisherIds.add(p.id);
        b.recentReleasesList.push(g);
      } else if (isPrevRelease) {
        b.prevReleasesCount += 1;
      }

      b.gamesList.push({ game: g, curDailyRate, curInstallGain });
    }
  }

  const allMedians = [...buckets.values()]
    .filter((b) => b.dailyRates.length >= 2)
    .map((b) => median(b.dailyRates));
  const overallGenreMedian = allMedians.length > 0 ? median(allMedians) : 50;

  const list = [];
  for (const b of buckets.values()) {
    if (b.trackedGamesCount < 2 && b.newReleasesCount === 0) continue;

    const medianDailyGrowthPerGame = Math.round(median(b.dailyRates));
    const growingSharePct = b.activeTelemetryCount > 0
      ? Math.round((b.growingGamesCount / b.activeTelemetryCount) * 100)
      : 0;

    let velocityChangePct = null;
    if (
      coverage?.comparisonStatus !== 'insufficient' &&
      b.matchedBaselineCount >= 2 &&
      b.matchedPrevDailySum > 10
    ) {
      velocityChangePct = Math.round(
        ((b.matchedCurDailySum - b.matchedPrevDailySum) / b.matchedPrevDailySum) * 100
      );
    }

    let signal = 'steady';
    if (
      (velocityChangePct !== null && velocityChangePct <= -15) ||
      (b.decliningGamesCount > b.growingGamesCount && b.activeTelemetryCount >= 3)
    ) {
      signal = 'declining';
    } else if (
      b.newReleasesCount >= 3 &&
      ((velocityChangePct !== null && velocityChangePct >= 15) ||
        (b.growingGamesCount >= 3 && medianDailyGrowthPerGame >= Math.max(25, overallGenreMedian * 1.1)))
    ) {
      signal = 'hot_wave';
    } else if (
      (velocityChangePct !== null && velocityChangePct >= 15) ||
      (growingSharePct >= 55 && medianDailyGrowthPerGame >= Math.max(25, overallGenreMedian))
    ) {
      signal = 'rising_demand';
    } else if (
      medianDailyGrowthPerGame >= Math.max(40, overallGenreMedian * 1.25) &&
      growingSharePct >= 45 &&
      b.newReleasesCount <= 3
    ) {
      signal = 'opportunity';
    } else if (
      b.newReleasesCount >= 4 &&
      ((velocityChangePct !== null && velocityChangePct < 5) || medianDailyGrowthPerGame < overallGenreMedian * 0.8)
    ) {
      signal = 'crowded';
    }

    const topGrowingGames = [...b.gamesList]
      .sort((a, c) => c.curDailyRate - a.curDailyRate || c.curInstallGain - a.curInstallGain)
      .slice(0, 5)
      .map((item) => ({
        ...toCompactGameSummary(item.game, historyByPkg, windowDays),
        genreDailyRate: Math.round(item.curDailyRate),
        genreWindowGain: Math.round(item.curInstallGain)
      }));

    const newestReleases = [...b.recentReleasesList]
      .sort((a, c) => {
        const da = getEffectiveDate(a, dateBasis) || '';
        const dc = getEffectiveDate(c, dateBasis) || '';
        return dc.localeCompare(da) || Number(c.real_installs || 0) - Number(a.real_installs || 0);
      })
      .slice(0, 5)
      .map((g) => toCompactGameSummary(g, historyByPkg, windowDays));

    list.push({
      genre: b.genre,
      mode,
      trackedGamesCount: b.trackedGamesCount,
      activeTelemetryCount: b.activeTelemetryCount,
      snapshotBackedCount: b.snapshotBackedCount,
      matchedBaselineCount: b.matchedBaselineCount,
      totalInstallGrowth: Math.round(b.totalInstallGrowth),
      totalDailyVelocity: Math.round(b.totalDailyVelocity),
      medianDailyGrowthPerGame,
      growingGamesCount: b.growingGamesCount,
      decliningGamesCount: b.decliningGamesCount,
      growingSharePct,
      velocityChangePct,
      newReleasesCount: b.newReleasesCount,
      prevReleasesCount: b.prevReleasesCount,
      distinctCompetitorsShipping: b.competitorKeys.size,
      distinctPublishersShipping: b.publisherIds.size,
      signal,
      topGrowingGames,
      newestReleases
    });
  }

  return list.sort(
    (a, b) =>
      b.medianDailyGrowthPerGame - a.medianDailyGrowthPerGame ||
      b.totalDailyVelocity - a.totalDailyVelocity ||
      b.newReleasesCount - a.newReleasesCount
  );
}

function analyzeGenreGrowth({
  games = [],
  historyByPkg = new Map(),
  coverage,
  windowDays = 30,
  dateBasis = 'release_date',
  now = new Date()
}) {
  const todayKey = parseDateKey(now);
  const primary = aggregateGenreBuckets({
    games,
    historyByPkg,
    coverage,
    windowDays,
    dateBasis,
    todayKey,
    mode: 'primary'
  });
  const subgenres = aggregateGenreBuckets({
    games,
    historyByPkg,
    coverage,
    windowDays,
    dateBasis,
    todayKey,
    mode: 'subgenre'
  });
  return { primary, subgenres: subgenres.slice(0, 25) };
}

function analyzeCompetitorActivity({
  games = [],
  historyByPkg = new Map(),
  windowDays = 30,
  dateBasis = 'release_date',
  now = new Date()
}) {
  const todayKey = parseDateKey(now);
  const windowStart = addDays(todayKey, -(windowDays - 1));
  const prevStart = addDays(todayKey, -(windowDays * 2 - 1));

  const compMap = new Map();

  for (const g of games) {
    const effDate = getEffectiveDate(g, dateBasis);
    const comps = (g.competitors && g.competitors.length > 0)
      ? g.competitors
      : g.publisher_id
      ? [{ key: `pub:${g.publisher_id}`, competitorId: null, name: g.publisher_display || g.publisher_name }]
      : [];

    for (const c of comps) {
      let entry = compMap.get(c.key);
      if (!entry) {
        entry = {
          key: c.key,
          competitorId: c.competitorId,
          competitorName: c.name,
          totalCatalogCount: 0,
          allHistoricalGames: [],
          recentReleases: [],
          prevReleasesCount: 0,
          activePubIds: new Set(),
          allPubIds: new Set()
        };
        compMap.set(c.key, entry);
      }

      for (const pub of g.publishers || []) entry.allPubIds.add(pub.id);
      entry.totalCatalogCount += 1;

      if (effDate && effDate >= windowStart && effDate <= todayKey) {
        entry.recentReleases.push(g);
        for (const pub of g.publishers || []) entry.activePubIds.add(pub.id);
      } else {
        entry.allHistoricalGames.push(g);
        if (effDate && effDate >= prevStart && effDate < windowStart) {
          entry.prevReleasesCount += 1;
        }
      }
    }
  }

  const activeCompetitors = [];
  const strategyShifts = [];

  for (const entry of compMap.values()) {
    if (entry.recentReleases.length === 0) continue;

    const genreCounts = new Map();
    let freeCount = 0;
    let paidCount = 0;
    let campaignCount = 0;
    let recentAppsCount = 0;
    let recentGamesCount = 0;

    for (const g of entry.recentReleases) {
      const genre = g.primaryGenre || 'Uncategorized';
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      if (g.pricing === 'paid') paidCount += 1;
      else freeCount += 1;
      if (g.has_campaign) campaignCount += 1;
      if (g.appType === 'app') recentAppsCount += 1;
      else recentGamesCount += 1;
    }

    const topGenres = [...genreCounts.entries()]
      .map(([genre, count]) => ({
        genre,
        count,
        sharePct: Math.round((count / entry.recentReleases.length) * 100)
      }))
      .sort((a, b) => b.count - a.count);

    // Historical baseline for pivot detection
    const histTotal = entry.allHistoricalGames.length;
    const histGenreCounts = new Map();
    let histGamesCount = 0;
    let histAppsCount = 0;
    for (const hg of entry.allHistoricalGames) {
      const gen = hg.primaryGenre || 'Uncategorized';
      histGenreCounts.set(gen, (histGenreCounts.get(gen) || 0) + 1);
      if (hg.appType === 'app') histAppsCount += 1;
      else histGamesCount += 1;
    }

    const shiftsForComp = [];

    // 1. Cross-category pivot (Games publisher launching Utility/Apps or vice versa)
    if (histTotal >= 5) {
      const histGameShare = histGamesCount / histTotal;
      if (histGameShare >= 0.8 && recentAppsCount >= 1) {
        const appExamples = entry.recentReleases
          .filter((g) => g.appType === 'app')
          .map((g) => toCompactGameSummary(g, historyByPkg, windowDays));
        const shift = {
          type: 'cross_category',
          competitorKey: entry.key,
          competitorName: entry.competitorName,
          badge: 'Cross-category shift',
          summary: `${entry.competitorName} (${Math.round(histGameShare * 100)}% games historically) shipped ${recentAppsCount} app${recentAppsCount === 1 ? '' : 's'} in this period.`,
          count: recentAppsCount,
          evidenceGames: appExamples.slice(0, 6)
        };
        shiftsForComp.push(shift);
        strategyShifts.push(shift);
      } else if (histAppsCount / histTotal >= 0.8 && recentGamesCount >= 2) {
        const gameExamples = entry.recentReleases
          .filter((g) => g.appType === 'game')
          .map((g) => toCompactGameSummary(g, historyByPkg, windowDays));
        const shift = {
          type: 'cross_category',
          competitorKey: entry.key,
          competitorName: entry.competitorName,
          badge: 'Cross-category shift',
          summary: `${entry.competitorName} (historically app-focused) launched ${recentGamesCount} games recently.`,
          count: recentGamesCount,
          evidenceGames: gameExamples.slice(0, 6)
        };
        shiftsForComp.push(shift);
        strategyShifts.push(shift);
      }

      // 2. New genre expansion
      for (const tg of topGenres) {
        if (tg.count < 2) continue;
        const histInGenre = histGenreCounts.get(tg.genre) || 0;
        const histShare = histInGenre / histTotal;
        if (histInGenre === 0 || histShare < 0.05) {
          const examples = entry.recentReleases
            .filter((g) => (g.primaryGenre || 'Uncategorized') === tg.genre)
            .map((g) => toCompactGameSummary(g, historyByPkg, windowDays));
          const shift = {
            type: 'new_genre',
            competitorKey: entry.key,
            competitorName: entry.competitorName,
            badge: 'New genre focus',
            summary: `${entry.competitorName} launched ${tg.count} ${tg.genre} titles vs ${histInGenre} previously tracked.`,
            genre: tg.genre,
            count: tg.count,
            evidenceGames: examples.slice(0, 6)
          };
          shiftsForComp.push(shift);
          strategyShifts.push(shift);
        }
      }
    }

    // 3. Repeated concept cluster within same competitor
    const localTermMap = new Map();
    for (const g of entry.recentReleases) {
      for (const gram of extractTitleNgrams(g.title)) {
        if (gram.wordCount < 2 || gram.distinctiveCount === 0) continue;
        if (!localTermMap.has(gram.term)) localTermMap.set(gram.term, []);
        localTermMap.get(gram.term).push(g);
      }
    }
    const topCluster = [...localTermMap.entries()]
      .filter(([, arr]) => arr.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (topCluster) {
      const [phrase, matched] = topCluster;
      const shift = {
        type: 'repeated_concept',
        competitorKey: entry.key,
        competitorName: entry.competitorName,
        badge: 'Concept push',
        summary: `${entry.competitorName} shipped ${matched.length} titles around "${formatTrendLabel(phrase)}".`,
        phrase,
        count: matched.length,
        evidenceGames: matched.slice(0, 6).map((g) => toCompactGameSummary(g, historyByPkg, windowDays))
      };
      shiftsForComp.push(shift);
      strategyShifts.push(shift);
    }

    const sortedReleases = [...entry.recentReleases]
      .sort((a, b) => {
        const da = getEffectiveDate(a, dateBasis) || '';
        const db = getEffectiveDate(b, dateBasis) || '';
        return db.localeCompare(da) || Number(b.real_installs || 0) - Number(a.real_installs || 0);
      })
      .map((g) => toCompactGameSummary(g, historyByPkg, windowDays));

    const releaseDeltaPct = entry.prevReleasesCount > 0
      ? Math.round(((entry.recentReleases.length - entry.prevReleasesCount) / entry.prevReleasesCount) * 100)
      : null;

    activeCompetitors.push({
      key: entry.key,
      competitorId: entry.competitorId,
      competitorName: entry.competitorName,
      totalCatalogCount: entry.totalCatalogCount,
      recentReleaseCount: entry.recentReleases.length,
      prevReleasesCount: entry.prevReleasesCount,
      releaseDeltaPct,
      activePublisherAccounts: entry.activePubIds.size,
      totalPublisherAccounts: entry.allPubIds.size,
      freeCount,
      paidCount,
      campaignCount,
      topGenres,
      shifts: shiftsForComp,
      recentReleases: sortedReleases.slice(0, 10)
    });
  }

  activeCompetitors.sort(
    (a, b) =>
      b.recentReleaseCount - a.recentReleaseCount ||
      b.shifts.length - a.shifts.length ||
      a.competitorName.localeCompare(b.competitorName)
  );

  strategyShifts.sort((a, b) => {
    const prio = { cross_category: 3, new_genre: 2, repeated_concept: 1 };
    return (prio[b.type] || 0) - (prio[a.type] || 0) || b.count - a.count;
  });

  return {
    activeCompetitorsCount: activeCompetitors.length,
    activeCompetitors,
    strategyShifts: strategyShifts.slice(0, 20)
  };
}

function detectBreakoutNewcomers({
  games = [],
  historyByPkg = new Map(),
  windowDays = 30,
  dateBasis = 'release_date',
  now = new Date()
}) {
  const todayKey = parseDateKey(now);
  const windowStart = addDays(todayKey, -(windowDays - 1));

  const candidates = [];
  for (const g of games) {
    if (g.is_suspended) continue;
    const effDate = getEffectiveDate(g, dateBasis);
    if (!effDate || effDate < windowStart || effDate > todayKey) continue;

    const daysLive = Math.max(1, dayDiff(todayKey, effDate) + 1);
    const totalInstalls = Number(g.real_installs != null ? g.real_installs : g.min_installs || 0);
    const hist = historyByPkg.get(g.package_name);
    const dailyVelocity = hist && hist.curDays > 0
      ? Math.max(0, Math.round(hist.curDailyRate))
      : Math.max(0, Number(g.installs_delta_1d || g.installs_avg_daily_7d || 0));

    const installsPerDaySinceLaunch = Math.max(
      Math.round(totalInstalls / daysLive),
      dailyVelocity
    );

    if (totalInstalls < 500 && dailyVelocity < 100) continue;

    candidates.push({
      game: g,
      effDate,
      daysLive,
      totalInstalls,
      dailyVelocity,
      installsPerDaySinceLaunch
    });
  }

  const medianRate = Math.max(
    1,
    Math.round(median(candidates.map((c) => c.installsPerDaySinceLaunch)))
  );

  return candidates
    .map((c) => ({
      ...toCompactGameSummary(c.game, historyByPkg, windowDays),
      effectiveDate: c.effDate,
      daysLive: c.daysLive,
      installsPerDaySinceLaunch: c.installsPerDaySinceLaunch,
      dailyVelocity: c.dailyVelocity,
      tractionMultiple: Number((c.installsPerDaySinceLaunch / medianRate).toFixed(1))
    }))
    .sort((a, b) => b.installsPerDaySinceLaunch - a.installsPerDaySinceLaunch || b.real_installs - a.real_installs)
    .slice(0, 30);
}

function buildMarketObservations({
  titleTrends,
  genreGrowth,
  competitorActivity,
  newcomers,
  coverage
}) {
  const observations = [];

  const topWave = titleTrends.emerging?.[0];
  if (topWave) {
    const statusLabel =
      topWave.status === 'new_wave' ? 'New wave'
      : topWave.status === 'emerging' ? 'Emerging'
      : 'Repeated theme';
    observations.push({
      id: `trend:${topWave.phrase}`,
      kind: 'title_trend',
      subject: `"${topWave.displayPhrase}"`,
      badge: statusLabel,
      badgeTone: topWave.status === 'new_wave' || topWave.status === 'emerging' ? 'accent' : 'neutral',
      summary: `${topWave.matchingGamesCount} title${topWave.matchingGamesCount === 1 ? '' : 's'} across ${topWave.distinctCompetitors} competitors${
        topWave.baselineGamesCount === 0
          ? ' with zero prior matches in Atlas'
          : ` vs ${topWave.baselineGamesCount} older matches`
      }.`,
      targetTab: 'trends',
      targetKey: topWave.phrase,
      evidenceGames: topWave.matchingGames.slice(0, 4)
    });
  }

  const risingGenre = genreGrowth.primary?.find(
    (g) => g.signal === 'hot_wave' || g.signal === 'rising_demand'
  ) || genreGrowth.primary?.[0];

  if (risingGenre) {
    const pctText = risingGenre.velocityChangePct != null
      ? `${risingGenre.velocityChangePct >= 0 ? '+' : ''}${risingGenre.velocityChangePct}% daily velocity vs prior window`
      : `median ${risingGenre.medianDailyGrowthPerGame.toLocaleString()}/day per tracked title`;
    observations.push({
      id: `genre-up:${risingGenre.genre}`,
      kind: 'genre_rising',
      subject: risingGenre.genre,
      badge: risingGenre.signal === 'hot_wave' ? 'Hot wave' : risingGenre.signal === 'rising_demand' ? 'Rising demand' : 'High velocity',
      badgeTone: 'success',
      summary: `Tracked ${risingGenre.genre} titles gained ${pctText}, with ${risingGenre.growingGamesCount}/${risingGenre.activeTelemetryCount} growing titles.`,
      targetTab: 'genres',
      targetKey: risingGenre.genre,
      evidenceGames: risingGenre.topGrowingGames.slice(0, 4)
    });
  }

  const decliningGenre = genreGrowth.primary?.find((g) => g.signal === 'declining');
  if (decliningGenre && (!risingGenre || decliningGenre.genre !== risingGenre.genre)) {
    observations.push({
      id: `genre-down:${decliningGenre.genre}`,
      kind: 'genre_declining',
      subject: decliningGenre.genre,
      badge: 'Cooling demand',
      badgeTone: 'danger',
      summary: `Tracked ${decliningGenre.genre} velocity dropped ${
        decliningGenre.velocityChangePct != null ? `${decliningGenre.velocityChangePct}%` : 'sharply'
      } across ${decliningGenre.decliningGamesCount} declining titles (${coverage.comparisonStatus} baseline).`,
      targetTab: 'genres',
      targetKey: decliningGenre.genre,
      evidenceGames: decliningGenre.topGrowingGames.slice(0, 4)
    });
  }

  const topShift = competitorActivity.strategyShifts?.[0];
  if (topShift) {
    observations.push({
      id: `shift:${topShift.competitorKey}:${topShift.type}`,
      kind: 'competitor_shift',
      subject: topShift.competitorName,
      badge: topShift.badge,
      badgeTone: 'warning',
      summary: topShift.summary,
      targetTab: 'competitors',
      targetKey: topShift.competitorKey,
      evidenceGames: (topShift.evidenceGames || []).slice(0, 4)
    });
  } else if (newcomers[0]) {
    const topNew = newcomers[0];
    observations.push({
      id: `newcomer:${topNew.package_name}`,
      kind: 'newcomer',
      subject: topNew.title,
      badge: 'Fastest newcomer',
      badgeTone: 'accent',
      summary: `Averaging ${topNew.installsPerDaySinceLaunch.toLocaleString()}/day over ${topNew.daysLive}d live (${topNew.real_installs.toLocaleString()} total tracked installs).`,
      targetTab: 'newcomers',
      targetKey: topNew.package_name,
      evidenceGames: newcomers.slice(0, 4)
    });
  }

  return observations;
}

function analyzeDataset({
  rows = [],
  historyRows = [],
  coverageRow = null,
  options = {},
  filterOptions = { competitors: [], groups: [] }
}) {
  const windowKey = VALID_WINDOWS.has(options.window) ? options.window : '30d';
  const windowDays = VALID_WINDOWS.get(windowKey);
  const appType = ['all', 'game', 'app'].includes(options.appType) ? options.appType : 'all';
  const dateBasis = options.dateBasis === 'first_seen_at' ? 'first_seen_at' : 'release_date';
  const competitorFilter = String(options.competitorId || 'all').trim();
  const now = options.now instanceof Date ? options.now : new Date();
  const todayKey = parseDateKey(now);
  const windowStart = addDays(todayKey, -(windowDays - 1));
  const prevStart = addDays(todayKey, -(windowDays * 2 - 1));

  const allDeduped = deduplicateGames(rows);

  // Scope filter (competitor list ID or group_<id>)
  let scopedGames = allDeduped;
  if (competitorFilter && competitorFilter !== 'all') {
    if (competitorFilter === 'ungrouped') {
      scopedGames = allDeduped.filter((g) => g._listIds.size === 0);
    } else if (competitorFilter.startsWith('group_')) {
      const grpId = Number(competitorFilter.slice(6));
      scopedGames = allDeduped.filter((g) => g._groupIds.has(grpId));
    } else {
      const listIdNum = Number(competitorFilter);
      if (Number.isInteger(listIdNum) && listIdNum > 0) {
        scopedGames = allDeduped.filter((g) => g._listIds.has(listIdNum));
      }
    }
  }

  // Segment filter (all | game | app)
  if (appType !== 'all') {
    scopedGames = scopedGames.filter((g) => g.appType === appType);
  }

  const historyByPkg = buildInstallHistoryMap(historyRows);
  let missingLaunchDateCount = 0;
  let newReleasesCount = 0;
  let prevReleasesCount = 0;
  let totalTrackedInstallGrowth = 0;
  let totalMatchedCurDaily = 0;
  let totalMatchedPrevDaily = 0;
  let activeSnapshotBackedGames = 0;
  let verifiedBothWindowsCount = 0;

  for (const g of scopedGames) {
    if (dateBasis === 'release_date' && !g.release_date) {
      missingLaunchDateCount += 1;
    }
    const eff = getEffectiveDate(g, dateBasis);
    if (eff && eff >= windowStart && eff <= todayKey) newReleasesCount += 1;
    else if (eff && eff >= prevStart && eff < windowStart) prevReleasesCount += 1;

    if (!g.is_suspended) {
      const hist = historyByPkg.get(g.package_name);
      if (hist && hist.hasVerifiedCur) {
        activeSnapshotBackedGames += 1;
        totalTrackedInstallGrowth += hist.curGain;
        if (hist.hasVerifiedPrev) {
          verifiedBothWindowsCount += 1;
          totalMatchedCurDaily += hist.curDailyRate;
          totalMatchedPrevDaily += hist.prevDailyRate;
        }
      }
    }
  }

  const coverage = computeHistoricalCoverage(coverageRow, windowDays, verifiedBothWindowsCount);

  const releaseDeltaPct = prevReleasesCount > 0
    ? Math.round(((newReleasesCount - prevReleasesCount) / prevReleasesCount) * 100)
    : null;

  const installVelocityDeltaPct =
    coverage.comparisonStatus !== 'insufficient' && totalMatchedPrevDaily > 50
      ? Math.round(((totalMatchedCurDaily - totalMatchedPrevDaily) / totalMatchedPrevDaily) * 100)
      : null;

  const titleTrends = detectTitleTrends({
    games: scopedGames,
    windowDays,
    dateBasis,
    now,
    historyByPkg
  });

  const genreGrowth = analyzeGenreGrowth({
    games: scopedGames,
    historyByPkg,
    coverage,
    windowDays,
    dateBasis,
    now
  });

  const competitorActivity = analyzeCompetitorActivity({
    games: scopedGames,
    historyByPkg,
    windowDays,
    dateBasis,
    now
  });

  const newcomers = detectBreakoutNewcomers({
    games: scopedGames,
    historyByPkg,
    windowDays,
    dateBasis,
    now
  });

  const observations = buildMarketObservations({
    titleTrends,
    genreGrowth,
    competitorActivity,
    newcomers,
    coverage
  });

  const recentTitles = scopedGames
    .map((g) => ({ g, eff: getEffectiveDate(g, dateBasis) }))
    .filter((item) => !item.g.is_suspended && item.eff && item.eff >= windowStart && item.eff <= todayKey)
    .sort((a, b) => b.eff.localeCompare(a.eff) || Number(b.g.real_installs || 0) - Number(a.g.real_installs || 0))
    .slice(0, 400)
    .map((item) => toCompactGameSummary(item.g, historyByPkg, windowDays));

  return {
    meta: {
      window: windowKey,
      windowDays,
      windowStart,
      windowEnd: todayKey,
      appType,
      dateBasis,
      competitorId: competitorFilter,
      trackedCatalogCount: scopedGames.length,
      missingLaunchDateCount,
      activeSnapshotBackedGames,
      generatedAt: now.toISOString(),
      coverage
    },
    kpis: {
      newReleasesCount,
      prevReleasesCount,
      releaseDeltaPct,
      trackedInstallGrowth: Math.round(totalTrackedInstallGrowth),
      installVelocityDeltaPct,
      emergingPhrasesCount: titleTrends.emergingCount,
      emergingCompetitorsSpread: titleTrends.emerging[0]?.distinctCompetitors || 0,
      breakoutNewcomersCount: newcomers.filter((n) => n.tractionMultiple >= 2 || n.installsPerDaySinceLaunch >= 2000).length,
      totalNewcomersEvaluated: newcomers.length
    },
    observations,
    titleTrends,
    genreGrowth,
    competitorActivity,
    newcomers,
    recentTitles,
    filterOptions
  };
}

async function fetchSummaryFromDb(pool, options = {}) {
  const windowKey = VALID_WINDOWS.has(options.window) ? options.window : '30d';
  const windowDays = VALID_WINDOWS.get(windowKey);

  const [gamesRes, listsRes, groupsRes, historyRes, coverageRes] = await Promise.all([
    pool.query(`
      SELECT
        g.id,
        g.package_name,
        g.title,
        g.category,
        g.subcategories,
        g.rating,
        g.ratings_count,
        g.icon,
        g.installs,
        g.min_installs,
        g.real_installs,
        g.installs_delta_1d,
        g.installs_avg_daily_7d,
        g.installs_total_7d,
        g.released,
        g.release_date::text AS release_date,
        g.first_seen_at,
        g.first_campaign_seen_at,
        g.developer_id,
        g.developer_name,
        g.is_paid,
        g.price,
        g.price_text,
        g.price_status,
        g.manual_price_status,
        g.release_status,
        g.is_suspended,
        g.suspended_at,
        g.campaign_active,
        g.campaign_source,
        g.ad_count,
        ag.account_id AS publisher_id,
        pp.publisher_name,
        pp.display_name AS publisher_display_name,
        pl.id AS list_id,
        pl.name AS list_name,
        pl.competitor_id,
        cgm.group_id
      FROM games g
      LEFT JOIN account_games ag ON ag.game_id = g.id
      LEFT JOIN play_publishers pp ON pp.id = ag.account_id
      LEFT JOIN play_list_publishers plp ON plp.publisher_id = pp.id
      LEFT JOIN play_lists pl ON pl.id = plp.list_id
      LEFT JOIN competitor_group_members cgm ON cgm.competitor_id = pl.competitor_id
    `),
    pool.query(`
      SELECT
        pl.id,
        pl.name,
        pl.competitor_id,
        COUNT(DISTINCT plp.publisher_id)::int AS account_count
      FROM play_lists pl
      LEFT JOIN play_list_publishers plp ON plp.list_id = pl.id
      GROUP BY pl.id
      ORDER BY pl.name ASC
    `),
    pool.query(`
      SELECT cg.id, cg.name, COUNT(cgm.competitor_id)::int AS member_count
      FROM competitor_groups cg
      LEFT JOIN competitor_group_members cgm ON cgm.group_id = cg.id
      GROUP BY cg.id
      ORDER BY cg.name ASC
    `),
    pool.query(
      `
      WITH real_rows AS (
        SELECT
          package_name,
          snapshot_date,
          real_installs,
          daily_delta,
          (snapshot_date >= CURRENT_DATE - ($1::int - 1)) AS is_cur
        FROM app_install_history
        WHERE snapshot_date = (created_at AT TIME ZONE 'UTC')::date
          AND snapshot_date >= CURRENT_DATE - ($1::int * 2 - 1)
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (PARTITION BY package_name, is_cur ORDER BY snapshot_date ASC) AS rn_asc,
          ROW_NUMBER() OVER (PARTITION BY package_name, is_cur ORDER BY snapshot_date DESC) AS rn_desc,
          COUNT(*) OVER (PARTITION BY package_name, is_cur) AS cnt,
          MIN(snapshot_date) OVER (PARTITION BY package_name, is_cur) AS min_dt,
          MAX(snapshot_date) OVER (PARTITION BY package_name, is_cur) AS max_dt
        FROM real_rows
      )
      SELECT
        package_name,
        COALESCE(MAX(cnt) FILTER (WHERE is_cur), 0)::int AS cur_days,
        COALESCE(MAX(real_installs) FILTER (WHERE is_cur AND rn_asc = 1), NULL) AS cur_first_installs,
        COALESCE(MAX(real_installs) FILTER (WHERE is_cur AND rn_desc = 1), NULL) AS cur_last_installs,
        COALESCE(MAX(daily_delta) FILTER (WHERE is_cur AND rn_asc = 1), 0) AS cur_first_delta,
        COALESCE((MAX(max_dt) FILTER (WHERE is_cur) - MAX(min_dt) FILTER (WHERE is_cur)), 0)::int AS cur_span_days,
        COALESCE(MAX(cnt) FILTER (WHERE NOT is_cur), 0)::int AS prev_days,
        COALESCE(MAX(real_installs) FILTER (WHERE NOT is_cur AND rn_asc = 1), NULL) AS prev_first_installs,
        COALESCE(MAX(real_installs) FILTER (WHERE NOT is_cur AND rn_desc = 1), NULL) AS prev_last_installs,
        COALESCE(MAX(daily_delta) FILTER (WHERE NOT is_cur AND rn_asc = 1), 0) AS prev_first_delta,
        COALESCE((MAX(max_dt) FILTER (WHERE NOT is_cur) - MAX(min_dt) FILTER (WHERE NOT is_cur)), 0)::int AS prev_span_days
      FROM ranked
      GROUP BY package_name
      HAVING COALESCE(MAX(cnt) FILTER (WHERE is_cur), 0) >= 2
          OR COALESCE(MAX(cnt) FILTER (WHERE NOT is_cur), 0) >= 2
      `,
      [windowDays]
    ),
    pool.query(
      `
      SELECT
        MIN(snapshot_date)::text AS min_dt,
        MAX(snapshot_date)::text AS max_dt,
        COUNT(DISTINCT snapshot_date)::int AS total_days,
        COUNT(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= CURRENT_DATE - ($1::int - 1))::int AS cur_days_covered,
        COUNT(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= CURRENT_DATE - ($1::int * 2 - 1) AND snapshot_date < CURRENT_DATE - ($1::int - 1))::int AS prev_days_covered
      FROM app_install_history
      WHERE snapshot_date = (created_at AT TIME ZONE 'UTC')::date
      `,
      [windowDays]
    )
  ]);

  return analyzeDataset({
    rows: gamesRes.rows,
    historyRows: historyRes.rows,
    coverageRow: coverageRes.rows[0] || null,
    options: { ...options, window: windowKey },
    filterOptions: {
      competitors: listsRes.rows,
      groups: groupsRes.rows
    }
  });
}

async function computeMarketSummary(pool, options = {}) {
  const windowKey = VALID_WINDOWS.has(options.window) ? options.window : '30d';
  const appType = ['all', 'game', 'app'].includes(options.appType) ? options.appType : 'all';
  const dateBasis = options.dateBasis === 'first_seen_at' ? 'first_seen_at' : 'release_date';
  const competitorId = String(options.competitorId || 'all').trim();
  const forceFresh = options.fresh === true;

  const cacheKey = `${windowKey}|${appType}|${dateBasis}|${competitorId}`;
  const cached = summaryCache.get(cacheKey);
  if (!forceFresh && cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  if (!forceFresh && inflightQueries.has(cacheKey)) {
    return inflightQueries.get(cacheKey);
  }

  const work = fetchSummaryFromDb(pool, { window: windowKey, appType, dateBasis, competitorId })
    .then((payload) => {
      if (summaryCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = summaryCache.keys().next().value;
        if (oldestKey !== undefined) summaryCache.delete(oldestKey);
      }
      summaryCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return payload;
    })
    .finally(() => {
      inflightQueries.delete(cacheKey);
    });

  inflightQueries.set(cacheKey, work);
  return work;
}

function registerMarketSummaryRoutes({ app, pool }) {
  app.get('/api/summary/market-pulse', async (req, res) => {
    try {
      const windowParam = String(req.query?.window || '30d');
      const appTypeParam = String(req.query?.appType || 'all');
      const competitorParam = String(req.query?.competitorId || 'all');
      const dateBasisParam = String(req.query?.dateBasis || 'release_date');
      const forceFresh = req.query?.fresh === '1';

      const currentEtag = `W/"summary-${summaryVersion}-${windowParam}-${appTypeParam}-${dateBasisParam}-${competitorParam}"`;
      res.set('ETag', currentEtag);
      res.set('Cache-Control', 'private, no-cache');

      const clientEtag = req.get('if-none-match');
      if (!forceFresh && clientEtag && clientEtag === currentEtag) {
        return res.status(304).end();
      }

      const payload = await computeMarketSummary(pool, {
        window: windowParam,
        appType: appTypeParam,
        competitorId: competitorParam,
        dateBasis: dateBasisParam,
        fresh: forceFresh
      });

      return res.json(payload);
    } catch (err) {
      console.error('[Market Summary Error]:', err);
      return res.status(500).json({ error: 'Failed to generate market summary.' });
    }
  });
}

module.exports = {
  resolveGameClassification,
  deduplicateGames,
  tokenizeTitle,
  extractTitleNgrams,
  detectTitleTrends,
  analyzeGenreGrowth,
  analyzeCompetitorActivity,
  detectBreakoutNewcomers,
  analyzeDataset,
  computeMarketSummary,
  registerMarketSummaryRoutes,
  invalidateMarketSummaryCache
};
