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

// ISO 3166-1 alpha-2 country / territory codes. Atlas checks every code so a
// narrow regional rollout cannot be missed just because it falls outside a
// hand-maintained "major markets" list.
const COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ",
  "EC","EE","EG","EH","ER","ES","ET",
  "FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU",
  "ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ",
  "LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ",
  "OM",
  "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY",
  "QA",
  "RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
  "UA","UG","UM","US","UY","UZ",
  "VA","VC","VE","VG","VI","VN","VU",
  "WF","WS",
  "YE","YT",
  "ZA","ZM","ZW"
];

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
      return {
        countryCode,
        countryName: getCountryName(countryCode),
        state: pageClassification.state,
        confidence: pageClassification.confidence,
        evidence: {
          classifierVersion: 2,
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

    return {
      countryCode,
      countryName: getCountryName(countryCode),
      state: classification.state,
      confidence: classification.confidence,
      evidence: {
        classifierVersion: 2,
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
      evidence: {
        classifierVersion: 2,
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
  classifyStorePage
};
