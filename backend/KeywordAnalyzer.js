const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','being','but','by','can','could','did','do','does','doing','for','from','had','has','have','having','he','her','here','hers','him','his','how','i','if','in','into','is','it','its','me','more','most','my','no','not','of','on','or','our','ours','out','over','own','she','so','some','such','than','that','the','their','theirs','them','then','there','these','they','this','those','through','to','too','under','up','us','very','was','we','were','what','when','where','which','while','who','why','will','with','would','you','your','yours',
  // Extremely generic store-description vocabulary. Keeping these out makes
  // the ranking useful for competitor positioning rather than English prose.
  'app','apps','game','games','gaming','play','player','players','playing','mobile','download','free','new','best','get','make','use','using','now','one','also','like','many','every','experience','enjoy','fun'
]);

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawTokens(value) {
  return cleanText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 2 && /[a-z]/.test(token));
}

function meaningfulTokens(value) {
  return rawTokens(value).filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function countTerms(terms) {
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

function phraseTerms(value, size) {
  const tokens = rawTokens(value);
  const phrases = [];

  for (let i = 0; i <= tokens.length - size; i += 1) {
    const window = tokens.slice(i, i + size);
    const meaningful = window.filter(token => token.length >= 3 && !STOPWORDS.has(token));

    // Require at least two meaningful words so phrases such as "the game"
    // cannot dominate the useful competitor-language signals.
    if (meaningful.length < 2) continue;
    if (STOPWORDS.has(window[0]) || STOPWORDS.has(window[window.length - 1])) continue;
    phrases.push(window.join(' '));
  }

  return phrases;
}

function mergeCountMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, (merged.get(key) || 0) + value);
    }
  }
  return merged;
}

function buildDocumentTerms(shortDescription, longDescription, type) {
  if (type === 'phrase') {
    return new Set([
      ...phraseTerms(shortDescription, 2),
      ...phraseTerms(shortDescription, 3),
      ...phraseTerms(longDescription, 2),
      ...phraseTerms(longDescription, 3)
    ]);
  }

  return new Set([
    ...meaningfulTokens(shortDescription),
    ...meaningfulTokens(longDescription)
  ]);
}

function distinctivenessLabel(documentShare) {
  if (documentShare <= 0.03) return 'very_high';
  if (documentShare <= 0.10) return 'high';
  if (documentShare <= 0.30) return 'medium';
  return 'low';
}

function analyzeTermGroup({ shortDescription, longDescription, corpus, type, limit = 30 }) {
  const shortCounts = type === 'phrase'
    ? mergeCountMaps(countTerms(phraseTerms(shortDescription, 2)), countTerms(phraseTerms(shortDescription, 3)))
    : countTerms(meaningfulTokens(shortDescription));
  const longCounts = type === 'phrase'
    ? mergeCountMaps(countTerms(phraseTerms(longDescription, 2)), countTerms(phraseTerms(longDescription, 3)))
    : countTerms(meaningfulTokens(longDescription));
  const totalCounts = mergeCountMaps(shortCounts, longCounts);
  const corpusSize = Math.max(1, corpus.length);
  const documentFrequency = new Map();

  for (const doc of corpus) {
    const terms = buildDocumentTerms(doc.short_description, doc.description, type);
    for (const term of terms) {
      if (!totalCounts.has(term)) continue;
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return [...totalCounts.entries()]
    .map(([term, count]) => {
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log((corpusSize + 1) / (df + 1)) + 1;
      const documentShare = df / corpusSize;
      const score = count * idf;
      return {
        term,
        type,
        count,
        shortCount: shortCounts.get(term) || 0,
        longCount: longCounts.get(term) || 0,
        documentFrequency: df,
        corpusSize,
        documentShare: Number((documentShare * 100).toFixed(1)),
        distinctiveness: distinctivenessLabel(documentShare),
        score: Number(score.toFixed(3))
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit);
}

function analyzeGameKeywords({ game, corpus, limit = 30 }) {
  const shortDescription = String(game?.short_description || game?.summary || '').trim();
  const longDescription = String(game?.description || '').trim();
  const docs = Array.isArray(corpus) && corpus.length > 0 ? corpus : [game || {}];

  return {
    packageName: game?.package_name || null,
    title: game?.title || null,
    shortDescription,
    longDescription,
    stats: {
      shortWordCount: rawTokens(shortDescription).length,
      longWordCount: rawTokens(longDescription).length,
      corpusGames: docs.length
    },
    phrases: analyzeTermGroup({ shortDescription, longDescription, corpus: docs, type: 'phrase', limit }),
    words: analyzeTermGroup({ shortDescription, longDescription, corpus: docs, type: 'word', limit })
  };
}

module.exports = {
  analyzeGameKeywords,
  cleanText
};
