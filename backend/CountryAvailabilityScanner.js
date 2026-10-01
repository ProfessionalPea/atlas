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

function classifyStorePage({ body, status, finalUrl, packageName }) {
  const text = String(body || "").toLowerCase();
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

  if (packagePresent && hasAny(text, [
    "aria-label=\"install\"",
    "aria-label='install'",
    ">install<",
    "\"install\"",
    "install on more devices"
  ])) {
    return { state: "live", confidence: "high", marker: "install_action" };
  }

  // Google changes the Play markup frequently. If the requested package is
  // embedded in a successful details page, the listing exists in that market.
  // Pre-registration / early-access markers above take precedence; otherwise
  // treat an accessible listing as live but keep confidence at medium.
  if (
    status >= 200 &&
    status < 400 &&
    packagePresent &&
    String(finalUrl || "").includes("/store/apps/details")
  ) {
    return { state: "live", confidence: "medium", marker: "listing_accessible" };
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
  url.searchParams.set("hl", "en");
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
    const classification = classifyStorePage({
      body,
      status: response.status,
      finalUrl: response.url,
      packageName
    });

    return {
      countryCode,
      countryName: getCountryName(countryCode),
      state: classification.state,
      confidence: classification.confidence,
      evidence: {
        httpStatus: response.status,
        marker: classification.marker,
        finalUrl: response.url,
        packagePresent: body.toLowerCase().includes(packageName.toLowerCase()),
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
  scanPackageCountries
};
