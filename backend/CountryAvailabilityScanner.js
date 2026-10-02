const gplayRaw = require("google-play-scraper");
const gplay = gplayRaw.default || gplayRaw;

const DEFAULT_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(process.env.COUNTRY_SCAN_CONCURRENCY) || 8)
);

const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Math.min(30000, Number(process.env.COUNTRY_SCAN_TIMEOUT_MS) || 12000)
);

// Individually targetable Google Play distribution locations.
//
// This intentionally does NOT use all ISO-3166 country/territory codes.
// Google Play Console exposes a smaller named storefront list; locations
// outside that list are handled by Google's "Rest of World" grouping and
// cannot be targeted individually. Atlas should mirror the Play Console
// control surface, so scans only include these named Google Play locations.
//
// Source of truth checked against Google's "Supported locations for
// distribution to Google Play users" table (176 named locations, Sep 2026).
const COUNTRY_CODES = [
  // United States and Canada
  "CA","US",

  // Europe
  "AL","AT","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GI",
  "GR","HU","IS","IE","IT","LV","LI","LT","LU","MT","MD","MC","NL","MK","NO",
  "PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","TR","UA","GB","VA",

  // Africa, Middle East, and India
  "DZ","AO","AM","AZ","BH","BJ","BW","BF","CM","CV","TD","KM","CD","CG","CI",
  "DJ","EG","ER","GA","GM","GE","GH","GN","GW","IN","IR","IQ","IL","JO","KE",
  "KW","LB","LR","LY","ML","MU","MA","MZ","NA","NE","NG","OM","QA","RW","SA",
  "SN","SC","SL","SO","ZA","SD","TZ","TG","TN","UG","AE","YE","ZM","ZW",

  // Latin America and the Caribbean
  "AG","AR","AW","BS","BZ","BM","BO","BR","VG","KY","CL","CO","CR","CU","DM",
  "DO","EC","SV","GD","GT","HT","HN","JM","MX","NI","PA","PY","PE","KN","LC",
  "SR","TT","TC","UY","VE",

  // Asia Pacific
  "AU","BD","KH","CN","FJ","HK","ID","JP","KZ","KG","LA","MO","MY","MV","FM",
  "MN","MM","NP","NZ","PK","PG","PH","WS","SG","SB","KR","LK","TW","TJ","TH",
  "TO","TM","UZ","VU","VN"
]

const displayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

function getCountryName(code) {
  try {
    return (displayNames && displayNames.of(code)) || code;
  } catch {
    return code;
  }
}

function normalizePackageName(value) {
  const packageName = String(value || "").trim();
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new Error("Enter a valid Android package name, e.g. com.example.game.");
  }
  return packageName;
}

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function normalizeStoreText(body) {
  return String(body || "")
    .toLowerCase()
    .replace(/\\u002d/g, "-")
    .replace(/&#45;|&#x2d;/g, "-")
    .replace(/&hyphen;/g, "-")
    .replace(/\u00ad/g, "");
}

function normalizeVisibleStoreText(body) {
  return normalizeStoreText(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getStoreOffer(appData, body = "") {
  const rawPrice = Number(appData?.price);
  const metadataPaid =
    appData?.free === false &&
    Number.isFinite(rawPrice) &&
    rawPrice > 0;

  if (metadataPaid) {
    return {
      isPaid: true,
      price: rawPrice,
      currency: appData?.currency ? String(appData.currency) : null,
      priceText: appData?.priceText ? String(appData.priceText) : null,
      source: "metadata"
    };
  }

  // Paid games are a special case for the HTML fallback. A valid paid listing
  // can expose a Buy CTA even when google-play-scraper times out or fails to
  // parse that storefront. That is still strong evidence the app is live.
  const visibleText = normalizeVisibleStoreText(body);
  const paidCta = visibleText.match(
    /((?:[$€£¥₹₩₽₺₫₱₦₴₪₵₲₡₭₮₸₼₾]\s*\d[\d.,]*|\b(?:usd|eur|gbp|cad|aud|nzd|inr|jpy|krw|brl|zar|ngn|aoa)\s*\d[\d.,]*))\s*(?:buy|purchase)\b/i
  );

  if (paidCta) {
    return {
      isPaid: true,
      price: null,
      currency: null,
      priceText: paidCta[1].trim(),
      source: "page_buy_cta"
    };
  }

  return {
    isPaid: false,
    price: Number.isFinite(rawPrice) ? rawPrice : null,
    currency: appData?.currency ? String(appData.currency) : null,
    priceText: appData?.priceText ? String(appData.priceText) : null,
    source: appData ? "metadata" : null
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || "Timed out.")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function isNotFoundError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || error || "").toLowerCase();
  return status === 404 ||
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("app not found");
}

function normalizeHistogram(histogram) {
  const source = histogram && typeof histogram === "object" ? histogram : {};
  const result = {};
  for (let star = 1; star <= 5; star += 1) {
    const value = Number(source[String(star)] ?? source[star] ?? 0);
    result[String(star)] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }
  return result;
}

function getMarketPerformance(appData) {
  if (!appData || typeof appData !== "object") {
    return {
      playRating: null,
      ratingsCount: 0,
      reviewsCount: 0,
      histogram: null,
      positiveRatings: 0,
      negativeRatings: 0,
      positiveShare: null,
      negativeShare: null,
      atlasMarketScore: null,
      performanceConfidence: "none"
    };
  }

  const playRatingValue = Number(appData.score);
  const playRating = Number.isFinite(playRatingValue) && playRatingValue > 0
    ? Number(playRatingValue.toFixed(3))
    : null;
  const ratingsCount = Math.max(0, Math.round(Number(appData.ratings) || 0));
  const reviewsCount = Math.max(0, Math.round(Number(appData.reviews) || 0));
  const histogram = normalizeHistogram(appData.histogram);
  const histogramTotal = Object.values(histogram).reduce((sum, value) => sum + value, 0);
  const positiveRatings = histogram["4"] + histogram["5"];
  const negativeRatings = histogram["1"] + histogram["2"];
  const positiveShare = histogramTotal > 0
    ? Number(((positiveRatings / histogramTotal) * 100).toFixed(2))
    : null;
  const negativeShare = histogramTotal > 0
    ? Number(((negativeRatings / histogramTotal) * 100).toFixed(2))
    : null;

  let observedRating = playRating;
  let evidenceCount = ratingsCount;

  if (histogramTotal > 0) {
    observedRating = (
      histogram["1"] +
      histogram["2"] * 2 +
      histogram["3"] * 3 +
      histogram["4"] * 4 +
      histogram["5"] * 5
    ) / histogramTotal;
    evidenceCount = histogramTotal;
  }

  // Confidence-adjusted score: shrink tiny samples toward a neutral-ish
  // 3.5-star prior so a country with only a handful of perfect ratings does
  // not outrank a market with thousands of consistently strong ratings.
  const priorRating = 3.5;
  const priorWeight = 25;
  const atlasMarketScore = observedRating && evidenceCount > 0
    ? Number(((
        ((observedRating * evidenceCount) + (priorRating * priorWeight)) /
        (evidenceCount + priorWeight)
      ) / 5 * 100).toFixed(2))
    : null;

  const performanceConfidence =
    evidenceCount >= 1000 ? "high" :
    evidenceCount >= 100 ? "medium" :
    evidenceCount > 0 ? "low" :
    "none";

  return {
    playRating,
    ratingsCount,
    reviewsCount,
    histogram: histogramTotal > 0 ? histogram : null,
    positiveRatings,
    negativeRatings,
    positiveShare,
    negativeShare,
    atlasMarketScore,
    performanceConfidence
  };
}

function classifyAppMetadata(appData) {
  if (!appData || typeof appData !== "object") return null;

  if (
    appData.preregister === true ||
    appData.preRegister === true ||
    appData.preRegistration === true
  ) {
    return { state: "pre_register", confidence: "high", marker: "metadata_preregister" };
  }

  if (appData.available === false) {
    return { state: "unavailable", confidence: "high", marker: "metadata_unavailable" };
  }

  const storeOffer = getStoreOffer(appData);
  if (storeOffer.isPaid) {
    return { state: "live", confidence: "high", marker: "metadata_paid_offer" };
  }

  const installsText = String(appData.installs ?? "").trim();
  const minInstallsRaw = appData.minInstalls;
  const minInstalls = Number(minInstallsRaw);
  const hasMinInstalls =
    minInstallsRaw !== null &&
    minInstallsRaw !== undefined &&
    minInstallsRaw !== "" &&
    Number.isFinite(minInstalls) &&
    minInstalls >= 0;
  const hasInstallEvidence = Boolean(installsText) || hasMinInstalls;

  const hasReleaseEvidence =
    Boolean(appData.released) ||
    (typeof appData.updated === "number" && appData.updated > 0) ||
    (typeof appData.updated === "string" && appData.updated.trim() !== "");

  const ratings = Number(appData.ratings);
  const reviews = Number(appData.reviews);
  const score = Number(appData.score);
  const hasRatingEvidence =
    (Number.isFinite(ratings) && ratings > 0) ||
    (Number.isFinite(reviews) && reviews > 0) ||
    (Number.isFinite(score) && score > 0);

  // Older google-play-scraper builds do not expose a documented preregister
  // boolean. Unreleased listings nevertheless have a distinctive "no offer"
  // shape: zero price, free=false, and no install/release/rating fields. Use
  // that only as a medium-confidence fallback.
  if (
    appData.price === 0 &&
    appData.free === false &&
    !hasInstallEvidence &&
    !hasReleaseEvidence &&
    !hasRatingEvidence
  ) {
    return { state: "pre_register", confidence: "medium", marker: "metadata_unreleased_shape" };
  }

  // A real production listing should expose at least one release signal. Do
  // not call a merely accessible details page "live"; pre-registration pages
  // are also HTTP 200 and contain generic install strings in Google scripts.
  if (hasInstallEvidence || hasReleaseEvidence || hasRatingEvidence) {
    return { state: "live", confidence: "high", marker: "metadata_release_signals" };
  }

  return null;
}

function classifyStorePage({ body, status, finalUrl, packageName }) {
  const text = normalizeStoreText(body);
  const packageLower = packageName.toLowerCase();

  if (status === 404 || status === 410) {
    return { state: "unavailable", confidence: "high", marker: "http_" + status };
  }

  if (hasAny(text, [
    "unusual traffic from your computer network",
    "/sorry/index",
    "recaptcha",
    "our systems have detected unusual traffic"
  ])) {
    return { state: "unknown", confidence: "low", marker: "anti_bot" };
  }

  if (hasAny(text, [
    "the requested url was not found on this server",
    "we couldn't find the requested url",
    "item not available",
    "this app is not available",
    "not available in your country"
  ])) {
    return { state: "unavailable", confidence: "high", marker: "unavailable_message" };
  }

  const packagePresent = text.includes(packageLower);

  if (packagePresent && hasAny(text, [
    "pre-register",
    "pre register",
    "preregister",
    "pre-registration",
    "pre registration"
  ])) {
    return { state: "pre_register", confidence: "high", marker: "pre_register" };
  }

  if (packagePresent && hasAny(text, [
    "early access",
    "join the beta",
    "beta tester",
    "become a tester"
  ])) {
    return { state: "early_access", confidence: "high", marker: "early_access" };
  }

  const pageOffer = getStoreOffer(null, body);
  if (packagePresent && pageOffer.isPaid) {
    return { state: "live", confidence: "high", marker: "paid_buy_cta" };
  }

  // Never infer LIVE from a generic "Install" string in the HTML. Google Play
  // includes install-related copy/scripts on pre-registration listings too.
  // A successful details page only proves that a listing exists; country-
  // specific release state is resolved from app metadata in probeCountry().
  if (
    status >= 200 &&
    status < 400 &&
    packagePresent &&
    String(finalUrl || "").includes("/store/apps/details")
  ) {
    return { state: "unknown", confidence: "low", marker: "listing_accessible_unverified" };
  }

  if (status >= 400) {
    return { state: "unavailable", confidence: "medium", marker: "http_" + status };
  }

  return { state: "unknown", confidence: "low", marker: "unclassified" };
}

async function probeCountry(packageName, countryCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  const url = new URL("https://play.google.com/store/apps/details");
  url.searchParams.set("id", packageName);
  // Use the same English locale form Google serves in the desktop Play UI.
  // It makes CTA text (including "Pre-register") more consistent.
  url.searchParams.set("hl", "en_US");
  url.searchParams.set("gl", countryCode);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 AtlasCountryScanner/1.0"
      }
    });

    const body = await response.text();
    const pageClassification = classifyStorePage({
      body,
      status: response.status,
      finalUrl: response.url,
      packageName
    });

    // Explicit page signals (Pre-register, Early access, or a hard unavailable
    // response) are already decisive and avoid an extra details lookup.
    if (["pre_register", "early_access", "unavailable"].includes(pageClassification.state)) {
      const storeOffer = getStoreOffer(null, body);
      return {
        countryCode,
        countryName: getCountryName(countryCode),
        state: pageClassification.state,
        confidence: pageClassification.confidence,
        isPaid: storeOffer.isPaid,
        price: storeOffer.price,
        currency: storeOffer.currency,
        priceText: storeOffer.priceText,
        evidence: {
          classifierVersion: 3,
          httpStatus: response.status,
          marker: pageClassification.marker,
          finalUrl: response.url,
          packagePresent: normalizeStoreText(body).includes(packageName.toLowerCase()),
          durationMs: Date.now() - startedAt
        }
      };
    }

    let metadataClassification = null;
    let metadataError = null;
    let appData = null;

    try {
      appData = await withTimeout(
        gplay.app({
          appId: packageName,
          country: countryCode.toLowerCase(),
          lang: "en"
        }),
        REQUEST_TIMEOUT_MS,
        "Google Play metadata lookup timed out."
      );
      metadataClassification = classifyAppMetadata(appData);
    } catch (error) {
      metadataError = error;
      if (isNotFoundError(error)) {
        metadataClassification = {
          state: "unavailable",
          confidence: "high",
          marker: "metadata_not_found"
        };
      }
    }

    const classification = metadataClassification || pageClassification;
    const marketPerformance = getMarketPerformance(appData);
    const storeOffer = getStoreOffer(appData, body);

    return {
      countryCode,
      countryName: getCountryName(countryCode),
      state: classification.state,
      confidence: classification.confidence,
      isPaid: storeOffer.isPaid,
      price: storeOffer.price,
      currency: storeOffer.currency,
      priceText: storeOffer.priceText,
      ...marketPerformance,
      evidence: {
        classifierVersion: 3,
        httpStatus: response.status,
        marker: classification.marker,
        pageMarker: pageClassification.marker,
        finalUrl: response.url,
        packagePresent: normalizeStoreText(body).includes(packageName.toLowerCase()),
        metadataPreregister:
          appData?.preregister === true ||
          appData?.preRegister === true ||
          appData?.preRegistration === true,
        metadataInstalls: appData?.installs ?? null,
        metadataMinInstalls: appData?.minInstalls ?? null,
        metadataReleased: appData?.released ?? null,
        metadataAvailable: appData?.available ?? null,
        metadataFree: appData?.free ?? null,
        metadataPrice: appData?.price ?? null,
        metadataCurrency: appData?.currency ?? null,
        metadataPriceText: appData?.priceText ?? null,
        storeOfferSource: storeOffer.source,
        metadataError: metadataError
          ? String(metadataError?.message || metadataError).slice(0, 300)
          : null,
        durationMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return {
      countryCode,
      countryName: getCountryName(countryCode),
      state: "unknown",
      confidence: "low",
      isPaid: false,
      price: null,
      currency: null,
      priceText: null,
      evidence: {
        classifierVersion: 3,
        marker: timedOut ? "timeout" : "request_error",
        error: String((error && error.message) || error).slice(0, 300),
        durationMs: Date.now() - startedAt
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function scanPackageCountries(packageNameInput, options = {}) {
  const packageName = normalizePackageName(packageNameInput);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const concurrency = Math.max(
    1,
    Math.min(12, Number(options.concurrency) || DEFAULT_CONCURRENCY)
  );

  const results = new Array(COUNTRY_CODES.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= COUNTRY_CODES.length) return;

      const countryCode = COUNTRY_CODES[index];
      const result = await probeCountry(packageName, countryCode);
      results[index] = result;
      completed += 1;

      onProgress({
        packageName,
        checked: completed,
        total: COUNTRY_CODES.length,
        currentCountry: countryCode,
        currentCountryName: result.countryName,
        lastState: result.state
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, COUNTRY_CODES.length) }, () => worker())
  );

  const counts = {
    live: 0,
    pre_register: 0,
    early_access: 0,
    unavailable: 0,
    unknown: 0
  };

  for (const result of results) {
    if (result && Object.prototype.hasOwnProperty.call(counts, result.state)) {
      counts[result.state] += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return {
    packageName,
    total: COUNTRY_CODES.length,
    counts,
    results
  };
}

module.exports = {
  COUNTRY_CODES,
  normalizePackageName,
  probeCountry,
  scanPackageCountries,
  classifyAppMetadata,
  classifyStorePage,
  getMarketPerformance,
  getStoreOffer
};
