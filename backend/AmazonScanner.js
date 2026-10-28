/**
 * Amazon Appstore research module (Phase 1: validation + listing scanner).
 *
 * Fully independent of the Google Play scanner / `games` table. It only reads public
 * Amazon search-result pages (publisher filter `p_4`), paginates them, and classifies each
 * unique ASIN as free / paid / unknown.
 *
 * Design notes:
 *  - Plain HTTP is intermittently challenged by Amazon's bot manager (interstitial JS
 *    proof-of-work), so a real Chromium context is used; it solves that challenge itself.
 *  - We never push through a captcha/robot check: on any block signal the publisher scan
 *    stops with status "blocked" and keeps whatever was collected ("partial" data).
 *  - Unknown prices are NEVER silently counted as free.
 *  - Review counts on result cards are abbreviated ("1.4K"), so they are approximate.
 */
const cheerio = require('cheerio');

const ALLOWED_HOST_RE = /^(www\.)?amazon\.(com|co\.uk|de|fr|it|es|ca|com\.au|in|co\.jp|com\.br|com\.mx|nl|se|pl|sg|ae|sa|com\.tr|eg)$/i;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

/* ------------------------------------------------------------------ validation */

/**
 * Validate a submitted link. Returns { valid, error?, publisher?, normalizedUrl?, host? }.
 * Supported format: Amazon search link filtered by publisher/brand, e.g.
 *   https://www.amazon.com/s?i=mobile-apps&rh=p_4%3AGames%2BArk&search-type=ss
 */
function validateAmazonUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { valid: false, error: 'Link is empty.' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'Not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, error: 'Link must use https://.' };
  }
  if (!ALLOWED_HOST_RE.test(url.hostname)) {
    return { valid: false, error: `"${url.hostname}" is not an Amazon store domain.` };
  }
  if (url.pathname !== '/s' && !url.pathname.endsWith('/s')) {
    return {
      valid: false,
      error: 'Unsupported Amazon link type. Use an Appstore publisher search link (…/s?i=mobile-apps&rh=p_4:<Publisher>).'
    };
  }

  const rh = url.searchParams.get('rh') || '';
  const m = rh.match(/(?:^|,)p_4:([^,]+)/i);
  if (!m) {
    return { valid: false, error: 'Link has no publisher filter (rh=p_4:<Publisher>), so it cannot identify a single publisher.' };
  }
  const publisher = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  if (!publisher) return { valid: false, error: 'Publisher name in the link is empty.' };

  const dept = (url.searchParams.get('i') || '').toLowerCase();
  if (dept && dept !== 'mobile-apps') {
    return { valid: false, error: `Link searches "${dept}", not the Appstore (i=mobile-apps).` };
  }

  // Normalise: Amazon's `rh=p_4:<Publisher>` parameter requires spaces inside the
  // publisher name to be encoded as `%2B` (not `+`, which causes an Amazon 503 error).
  const host = url.hostname.toLowerCase();
  const encodedPub = encodeURIComponent(publisher).replace(/%20/g, '%2B');
  const normalizedUrl = `https://${host}/s?i=mobile-apps&rh=p_4%3A${encodedPub}&search-type=ss`;
  return { valid: true, publisher, host, normalizedUrl };
}

/** Validate a batch: flags invalid entries and duplicate publishers (same host + publisher). */
function validateBatch(inputs) {
  const seen = new Map();
  return (inputs || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((input, index) => {
      const v = validateAmazonUrl(input);
      const entry = { index, input, ...v, duplicate: false };
      if (v.valid) {
        const key = `${v.host}|${v.publisher.toLowerCase()}`;
        if (seen.has(key)) {
          entry.duplicate = true;
          entry.duplicateOf = seen.get(key);
        } else {
          seen.set(key, index);
        }
      }
      return entry;
    });
}

/* --------------------------------------------------------------------- parsing */

function parseCount(text) {
  const m = String(text || '').replace(/[,\s]/g, '').match(/^\(?([\d.]+)([KkMm])?\)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = /k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1;
  return Math.round(n * mult);
}

function parsePrice(text) {
  const s = String(text || '').replace(/\u00a0/g, ' ').trim();
  if (!s) return { amount: null, currency: null };
  const cur = (s.match(/^[^\d\s.,-]+/) || [null])[0];
  const numMatch = s.match(/(\d[\d,]*(?:\.\d+)?)/);
  if (!numMatch) return { amount: null, currency: cur };
  return { amount: parseFloat(numMatch[1].replace(/,/g, '')), currency: cur ? cur.trim() : null };
}

function parseReleaseDate(text) {
  const m = String(text || '').match(/([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
  if (!m) return null;
  const d = new Date(`${m[1]} UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function classify(amount, text) {
  if (amount === null || amount === undefined) {
    return /\bfree\b/i.test(text || '') ? 'free' : 'unknown';
  }
  return amount === 0 ? 'free' : 'paid';
}

function parseCard($, el, host) {
  const c = $(el);
  const asin = c.attr('data-asin');
  if (!asin || !/^B[0-9A-Z]{9}$/.test(asin)) return null;

  const title = c.find('h2').first().text().replace(/\s+/g, ' ').trim();
  const priceText = c.find('.a-price .a-offscreen').first().text().trim();
  const { amount, currency } = parsePrice(priceText);
  const ratingLabel = c.find('[aria-label*="out of 5"]').first().attr('aria-label') || '';
  const rating = parseFloat((ratingLabel.match(/([\d.]+) out of 5/) || [])[1]);
  const reviewText = c.find('a[href*="customerReviews"] span, .s-underline-text').first().text().trim();
  const cardText = c.text().replace(/\s+/g, ' ');
  const href = c.find('h2 a').attr('href') || '';
  const hasPriceBlock = c.find('.a-price').length > 0;

  return {
    asin,
    title,
    url: `https://${host}/dp/${asin}`,
    icon: c.find('img.s-image').first().attr('src') || null,
    priceText: priceText || null,
    price: amount,
    currency,
    pricing: hasPriceBlock ? classify(amount, cardText) : classify(null, cardText),
    rating: Number.isFinite(rating) ? rating : null,
    reviewCount: parseCount(reviewText),
    reviewCountApprox: /[KkMm]\)?$/.test(reviewText.replace(/\s/g, '')),
    releaseDate: parseReleaseDate(cardText),
    sponsored: /Sponsored/i.test(cardText.slice(0, 80)) || /\/sspa\//.test(href)
  };
}

/** Parse one results page. */
function parseListingHtml(html, host = 'www.amazon.com') {
  const $ = cheerio.load(html);
  const games = [];
  $('div[data-component-type="s-search-result"]').each((_, el) => {
    const g = parseCard($, el, host);
    if (g) games.push(g);
  });

  const totalText = $('.s-breadcrumb, [data-component-type="s-result-info-bar"]').text().replace(/\s+/g, ' ');
  const tm =
    totalText.match(/of (?:over )?([\d,]+) results/i) ||
    totalText.match(/(?:^|\s)([\d,]+) results?\b/i) ||
    html.match(/of (?:over )?([\d,]+) results/i);
  const nextA = $('a.s-pagination-next:not(.s-pagination-disabled)').first();
  let nextUrl = nextA.attr('href') || null;
  if (nextUrl && nextUrl.startsWith('/')) nextUrl = `https://${host}${nextUrl}`;

  return {
    games,
    reportedTotal: tm ? parseInt(tm[1].replace(/,/g, ''), 10) : null,
    nextUrl
  };
}

/** Detect captcha / robot-check / unavailable pages. */
function detectBlock(html, status) {
  if (status === 503 || status === 429) return `HTTP ${status}`;
  if (/Enter the characters you see below|Type the characters you see in this image|api-services-support@amazon\.com|Robot Check/i.test(html)) {
    return 'captcha / robot check';
  }
  return null;
}

/* ----------------------------------------------------------------------- stats */

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeStats(games) {
  const free = games.filter((g) => g.pricing === 'free');
  const paid = games.filter((g) => g.pricing === 'paid');
  const unknown = games.filter((g) => g.pricing === 'unknown');
  const paidPrices = paid.map((g) => g.price).filter((p) => p !== null);
  const rated = games.filter((g) => g.rating !== null);
  const sum = (arr, f) => arr.reduce((a, g) => a + (f(g) || 0), 0);
  const totalReviews = sum(games, (g) => g.reviewCount);
  const freeReviews = sum(free, (g) => g.reviewCount);
  const currencies = [...new Set(games.map((g) => g.currency).filter(Boolean))];

  return {
    total: games.length,
    free: free.length,
    paid: paid.length,
    unknown: unknown.length,
    freeShare: games.length ? free.length / games.length : null,
    freeToPaidRatio: paid.length ? free.length / paid.length : null,
    currencies,
    avgPaidPrice: paidPrices.length ? paidPrices.reduce((a, b) => a + b, 0) / paidPrices.length : null,
    medianPaidPrice: median(paidPrices),
    avgRating: rated.length ? rated.reduce((a, g) => a + g.rating, 0) / rated.length : null,
    totalReviews,
    freeReviewShare: totalReviews ? freeReviews / totalReviews : null,
    reviewsApproximate: games.some((g) => g.reviewCountApprox)
  };
}

/* --------------------------------------------------------------------- scanning */

async function newScanContext(chromium, options = {}) {
  const launch = { headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] };
  const proxy = options.proxy || process.env.ATLAS_AMAZON_PROXY || null;
  if (proxy) launch.proxy = { server: proxy };
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // Set USD currency preference so Amazon renders consistent USD prices regardless of server IP region.
  await context.addCookies([
    { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
    { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' }
  ]);
  // Warm up the Amazon session once so search endpoints receive established session cookies.
  if (options.warmup !== false) {
    const warmPage = await context.newPage();
    try {
      await warmPage.goto('https://www.amazon.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(1200);
    } catch {
      // Non-fatal: proceed even if homepage warmup times out.
    } finally {
      await warmPage.close().catch(() => {});
    }
  }
  return { browser, context };
}

/**
 * Scan one publisher. Never throws for block/network problems: returns
 * { status: 'complete' | 'partial' | 'blocked' | 'error', games, stats, pagesRead, ... }.
 */
async function scanPublisher(context, validated, options = {}) {
  const { maxPages = 30, onProgress = () => {}, isCancelled = () => false } = options;
  const byAsin = new Map();
  const result = {
    publisher: validated.publisher,
    sourceUrl: validated.normalizedUrl,
    host: validated.host,
    status: 'complete',
    statusDetail: null,
    pagesRead: 0,
    reportedTotal: null,
    games: [],
    stats: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  const page = await context.newPage();
  let nextUrl = validated.normalizedUrl;
  let consecutiveEmpty = 0;

  try {
    while (nextUrl && result.pagesRead < maxPages) {
      if (isCancelled()) {
        result.status = 'partial';
        result.statusDetail = 'cancelled by user';
        break;
      }

      let html = '';
      let httpStatus = 200;
      let attempt = 0;
      let parsed = null;
      let blocked = null;

      // Bounded 2 attempts per page with tight timeouts so a slow/blocked page never hangs a batch.
      while (attempt < 2) {
        attempt += 1;
        if (attempt > 1) {
          onProgress({
            publisher: validated.publisher,
            page: result.pagesRead + 1,
            found: byAsin.size,
            reportedTotal: result.reportedTotal,
            phase: 'retrying',
            attempt
          });
          // Re-warm homepage briefly before retry if Amazon served a 503 or empty challenge page
          try {
            await page.goto(`https://${validated.host}/`, { waitUntil: 'domcontentloaded', timeout: 12000 });
            await sleep(1000);
          } catch {}
        }
        try {
          const resp = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 22000 });
          httpStatus = resp ? resp.status() : 200;
          try {
            await page.waitForSelector('div[data-component-type="s-search-result"], #captchacharacters, .a-no-results, #noResultsTitle', { timeout: 8000 });
          } catch {
            // If an interstitial auto-reloaded the page, wait briefly for the reload to settle.
            await sleep(1500);
          }
          html = await page.content();
        } catch (err) {
          result.statusDetail = `navigation error: ${err.message}`;
          await sleep(jitter(1200, 2200));
          continue;
        }
        parsed = parseListingHtml(html, validated.host);
        if (parsed.games.length > 0) {
          blocked = null;
          break;
        }
        blocked = detectBlock(html, httpStatus);
        if (blocked && (blocked !== 'HTTP 503' || attempt >= 2)) break; // stop immediately on captcha/429, allow 1 retry on transient 503
        if (/no results|did not match any/i.test(html)) break;
        await sleep(jitter(1200, 2200)); // transient/interstitial page; retry once
      }

      if (blocked) {
        result.status = 'blocked';
        result.statusDetail = blocked;
        break;
      }
      if (!parsed) {
        result.status = result.games.length ? 'partial' : 'error';
        break;
      }
      if (parsed.games.length === 0 && !/no results|did not match any/i.test(html)) {
        // Zero cards without a "no results" message means we did not get a real results page
        // (challenge/interstitial/unrendered). Never report that as a successful empty scan.
        result.status = byAsin.size ? 'partial' : 'error';
        result.statusDetail = `page ${result.pagesRead + 1} returned no listings (likely an unresolved bot challenge; title="${(html.match(/<title>([^<]*)/i) || [])[1] || ''}")`;
        break;
      }

      result.pagesRead += 1;
      if (parsed.reportedTotal && !result.reportedTotal) result.reportedTotal = parsed.reportedTotal;

      let added = 0;
      for (const g of parsed.games) {
        if (g.sponsored) continue; // sponsored slots are ads for other items, not this publisher's catalogue
        if (!byAsin.has(g.asin)) {
          byAsin.set(g.asin, g);
          added += 1;
        }
      }
      onProgress({ publisher: validated.publisher, page: result.pagesRead, found: byAsin.size, reportedTotal: result.reportedTotal });

      consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= 2) break; // pagination looping, stop
      nextUrl = parsed.nextUrl;
      if (nextUrl) await sleep(jitter(1500, 3200)); // pacing between pages
    }

    if (nextUrl && result.pagesRead >= maxPages && result.status === 'complete') {
      result.status = 'partial';
      result.statusDetail = `page limit (${maxPages}) reached`;
    }
  } catch (err) {
    result.status = byAsin.size ? 'partial' : 'error';
    result.statusDetail = err.message;
  } finally {
    await page.close().catch(() => {});
  }

  result.games = [...byAsin.values()];
  result.stats = computeStats(result.games);
  // Sanity: a "complete" scan that found far fewer unique games than Amazon reports is flagged.
  if (result.status === 'complete' && result.reportedTotal && result.games.length < result.reportedTotal * 0.9) {
    result.status = 'partial';
    result.statusDetail = `found ${result.games.length} of ${result.reportedTotal} reported results`;
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * Scan several publishers with bounded concurrency. Stops launching new publishers
 * once a block is seen (pause rather than hammer).
 */
async function scanPublishers(inputs, options = {}) {
  const { chromium } = require('playwright');
  const { concurrency = 1, onProgress = () => {}, onPublisherDone = () => {}, isCancelled = () => false } = options;

  const batch = validateBatch(inputs);
  const todo = batch.filter((b) => b.valid && !b.duplicate);
  const results = [];
  let blockedSeen = false;
  let cursor = 0;

  const { browser, context } = await newScanContext(chromium, options);
  try {
    const worker = async () => {
      while (cursor < todo.length && !isCancelled()) {
        const item = todo[cursor++];
        if (blockedSeen) {
          const skipped = {
            publisher: item.publisher, sourceUrl: item.normalizedUrl, host: item.host,
            status: 'skipped', statusDetail: 'paused after Amazon block signal', games: [], stats: computeStats([]), pagesRead: 0
          };
          results.push(skipped);
          onPublisherDone(skipped);
          continue;
        }
        const r = await scanPublisher(context, item, { ...options, onProgress });
        if (r.status === 'blocked' && r.statusDetail !== 'HTTP 503') blockedSeen = true;
        results.push(r);
        onPublisherDone(r);
        await sleep(jitter(1200, 2200));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  return { validation: batch, results };
}

module.exports = {
  validateAmazonUrl,
  validateBatch,
  parseListingHtml,
  parseCard,
  parseCount,
  parsePrice,
  computeStats,
  detectBlock,
  scanPublisher,
  scanPublishers
};
