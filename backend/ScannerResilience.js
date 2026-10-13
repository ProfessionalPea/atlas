const CHALLENGE_PATTERN = /unusual traffic|our systems have detected|automated (?:queries|requests)|google\.com\/sorry|\/sorry\/index|verify (?:that )?you(?:'re| are) human|complete the security check|traffic from your computer network|please verify you are human|security challenge/i;

function isGoogleHost(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase();
    return hostname === 'google.com' || hostname.endsWith('.google.com');
  } catch {
    return false;
  }
}

function classifyGoogleResponse({
  status = 0,
  contentType = '',
  body = '',
  resourceType = '',
  url = ''
} = {}) {
  const numericStatus = Number(status) || 0;
  const type = String(resourceType || '').toLowerCase();
  const mime = String(contentType || '').toLowerCase();
  const sample = String(body || '').slice(0, 250000);
  const bodyStart = sample.slice(0, 1000);
  const isGoogle = isGoogleHost(url);
  const isHtml =
    /text\/html|application\/xhtml\+xml/i.test(mime) ||
    /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(bodyStart);
  const isFullHtmlDocument = /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(bodyStart);

  if (isGoogle && numericStatus === 429) {
    return { blocked: true, suspicious: true, reason: 'Google returned HTTP 429 (rate limited).' };
  }

  if (isGoogle && numericStatus === 403) {
    return { blocked: true, suspicious: true, reason: 'Google returned HTTP 403 for a scan request.' };
  }

  if (isGoogle && isHtml && CHALLENGE_PATTERN.test(sample)) {
    return { blocked: true, suspicious: true, reason: 'Google returned an HTML challenge or unusual-traffic page.' };
  }

  // RPC/fetch calls should return structured data, not a complete HTML document.
  // Ordinary creative-document HTML is not treated as a challenge.
  if (
    isGoogle &&
    ['xhr', 'fetch'].includes(type) &&
    numericStatus >= 200 &&
    numericStatus < 300 &&
    isFullHtmlDocument
  ) {
    return {
      blocked: true,
      suspicious: true,
      reason: 'A Google XHR/fetch request returned a full HTML document instead of its expected data payload.'
    };
  }

  if (isGoogle && numericStatus >= 500) {
    return {
      blocked: false,
      suspicious: true,
      reason: 'Google returned HTTP ' + numericStatus + '; the response may be transiently unavailable.'
    };
  }

  if (isGoogle && numericStatus >= 400 && numericStatus !== 404) {
    return {
      blocked: false,
      suspicious: true,
      reason: 'Google returned HTTP ' + numericStatus + ' for a scan resource.'
    };
  }

  if (isGoogle && ['xhr', 'fetch'].includes(type) && isHtml) {
    return {
      blocked: false,
      suspicious: true,
      reason: 'A Google XHR/fetch response had an unexpected HTML content type.'
    };
  }

  return { blocked: false, suspicious: false, reason: null };
}

function createBoundedQueue(worker, options = {}) {
  if (typeof worker !== 'function') throw new TypeError('Queue worker must be a function.');

  const concurrency = Math.max(1, Number(options.concurrency) || 1);
  const maxPending = Math.max(concurrency, Number(options.maxPending) || concurrency * 4);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const items = [];
  const capacityWaiters = [];
  const idleWaiters = [];
  let active = 0;
  let completed = 0;
  let failed = 0;

  function wakeAll(waiters) {
    while (waiters.length) waiters.shift()();
  }

  function notifyIdleIfNeeded() {
    if (active === 0 && items.length === 0) wakeAll(idleWaiters);
  }

  function pump() {
    while (active < concurrency && items.length > 0) {
      const item = items.shift();
      active += 1;
      Promise.resolve()
        .then(() => worker(item))
        .then(() => { completed += 1; })
        .catch(error => {
          failed += 1;
          try { onError(error, item); } catch {}
        })
        .finally(() => {
          active -= 1;
          wakeAll(capacityWaiters);
          pump();
          notifyIdleIfNeeded();
        });
    }
  }

  async function enqueue(item) {
    while (items.length + active >= maxPending) {
      await new Promise(resolve => capacityWaiters.push(resolve));
    }
    items.push(item);
    pump();
  }

  function onIdle() {
    if (active === 0 && items.length === 0) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
  }

  function snapshot() {
    return {
      active,
      queued: items.length,
      pending: active + items.length,
      completed,
      failed,
      concurrency,
      maxPending
    };
  }

  return { enqueue, onIdle, snapshot };
}

async function waitForStableSignal(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const inspect = typeof options.inspect === 'function' ? options.inspect : async () => {};
  const getSignature = typeof options.getSignature === 'function' ? options.getSignature : () => '';
  const getLastActivityAt = typeof options.getLastActivityAt === 'function'
    ? options.getLastActivityAt
    : () => now();
  const getPendingCount = typeof options.getPendingCount === 'function'
    ? options.getPendingCount
    : () => 0;
  const shouldExtendWait = typeof options.shouldExtendWait === 'function'
    ? options.shouldExtendWait
    : () => false;
  const getStopError = typeof options.getStopError === 'function' ? options.getStopError : () => null;

  const minWaitMs = Math.max(0, Number(options.minWaitMs ?? 1800));
  const stableForMs = Math.max(0, Number(options.stableForMs ?? 1500));
  const quietForMs = Math.max(0, Number(options.quietForMs ?? 1000));
  const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs ?? 500));
  const normalMaxWaitMs = Math.max(minWaitMs, Number(options.normalMaxWaitMs ?? 6000));
  const slowMaxWaitMs = Math.max(normalMaxWaitMs, Number(options.slowMaxWaitMs ?? 15000));

  function throwIfStopped() {
    const stop = getStopError();
    if (!stop) return;
    if (stop instanceof Error) throw stop;
    const error = new Error(stop.message || String(stop));
    error.code = stop.code || 'ATLAS_SCAN_STOPPED';
    throw error;
  }

  const startedAt = now();
  let previousSignature = String(getSignature() ?? '');
  let stableSince = startedAt;

  while (true) {
    throwIfStopped();
    const currentMaxWaitMs = shouldExtendWait() ? slowMaxWaitMs : normalMaxWaitMs;
    const elapsedBeforeSleep = now() - startedAt;
    if (elapsedBeforeSleep >= currentMaxWaitMs) {
      return { status: 'max-wait', elapsedMs: elapsedBeforeSleep, maxWaitMs: currentMaxWaitMs };
    }

    await sleep(Math.min(pollIntervalMs, currentMaxWaitMs - elapsedBeforeSleep));
    throwIfStopped();
    await inspect();
    throwIfStopped();

    const currentTime = now();
    const elapsedMs = currentTime - startedAt;
    const signature = String(getSignature() ?? '');
    const lastActivityAt = Number(getLastActivityAt());
    const quietMs = Number.isFinite(lastActivityAt) ? currentTime - lastActivityAt : Infinity;
    const pendingCount = Math.max(0, Number(getPendingCount()) || 0);

    if (signature !== previousSignature || quietMs < quietForMs || pendingCount > 0) {
      stableSince = currentTime;
    } else if (elapsedMs >= minWaitMs && currentTime - stableSince >= stableForMs) {
      return { status: 'settled', elapsedMs, maxWaitMs: shouldExtendWait() ? slowMaxWaitMs : normalMaxWaitMs };
    }

    previousSignature = signature;
    const maxWaitAfterInspection = shouldExtendWait() ? slowMaxWaitMs : normalMaxWaitMs;
    if (elapsedMs >= maxWaitAfterInspection) {
      return { status: 'max-wait', elapsedMs, maxWaitMs: maxWaitAfterInspection };
    }
  }
}

module.exports = {
  isGoogleHost,
  classifyGoogleResponse,
  createBoundedQueue,
  waitForStableSignal
};
