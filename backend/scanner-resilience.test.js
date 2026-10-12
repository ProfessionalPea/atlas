const assert = require('node:assert/strict');
const {
  isGoogleHost,
  classifyGoogleResponse,
  createBoundedQueue,
  waitForStableSignal
} = require('./ScannerResilience');

assert.equal(isGoogleHost('https://adstransparency.google.com/advertiser/AR123'), true);
assert.equal(isGoogleHost('https://not-google.example/path'), false);

{
  const result = classifyGoogleResponse({
    status: 429,
    contentType: 'application/json',
    body: '{}',
    resourceType: 'fetch',
    url: 'https://adstransparency.google.com/pagead/lookup'
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /429/);
}

{
  const result = classifyGoogleResponse({
    status: 200,
    contentType: 'text/html; charset=UTF-8',
    body: '<!doctype html><html><title>Sorry</title><body>Our systems have detected unusual traffic.</body></html>',
    resourceType: 'document',
    url: 'https://adstransparency.google.com/advertiser/AR123'
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /challenge|unusual-traffic/i);
}

{
  const result = classifyGoogleResponse({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><title>Single Ad Rendering Service</title><body>Creative preview</body></html>',
    resourceType: 'document',
    url: 'https://adstransparency.google.com/advertiser/AR123/creative/CR123'
  });
  assert.equal(result.blocked, false, 'normal creative document HTML must remain valid');
}

{
  const result = classifyGoogleResponse({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><title>Temporary browser interstitial</title></html>',
    resourceType: 'fetch',
    url: 'https://adstransparency.google.com/pagead/lookup'
  });
  assert.equal(result.blocked, true, 'full HTML returned by an XHR/fetch endpoint is a soft-block signal');
}

{
  const result = classifyGoogleResponse({
    status: 200,
    contentType: 'text/html',
    body: '<div class="snippet">HTML fragment</div>',
    resourceType: 'fetch',
    url: 'https://adstransparency.google.com/pagead/lookup'
  });
  assert.equal(result.blocked, false, 'HTML fragments should not be treated as full-page blocks');
  assert.equal(result.suspicious, true);
}

{
  const result = classifyGoogleResponse({
    status: 403,
    contentType: 'text/html',
    body: 'Forbidden',
    resourceType: 'xhr',
    url: 'https://adstransparency.google.com/pagead/lookup'
  });
  assert.equal(result.blocked, true);
}

{
  const result = classifyGoogleResponse({
    status: 403,
    contentType: 'text/html',
    body: 'Forbidden',
    resourceType: 'fetch',
    url: 'https://example.org/resource'
  });
  assert.equal(result.blocked, false, 'unrelated third-party failures must not stop the scan');
}

(async () => {
  {
    let virtualTime = 0;
    let activityAt = 0;
    let pending = 1;
    let signature = 'loading';

    const result = await waitForStableSignal({
      now: () => virtualTime,
      sleep: async milliseconds => {
        virtualTime += milliseconds;
        if (virtualTime >= 700) {
          pending = 0;
          activityAt = virtualTime;
          signature = 'package-found';
        }
      },
      inspect: async () => {},
      getSignature: () => signature,
      getLastActivityAt: () => activityAt,
      getPendingCount: () => pending,
      minWaitMs: 500,
      stableForMs: 400,
      quietForMs: 300,
      pollIntervalMs: 100,
      normalMaxWaitMs: 3000,
      slowMaxWaitMs: 3000
    });
    assert.equal(result.status, 'settled');
    assert.ok(result.elapsedMs >= 1100, 'adaptive wait settled before the late payload had time to stabilize');
    assert.equal(signature, 'package-found');
  }

  {
    let active = 0;
    let maxActive = 0;
    const completedItems = [];
    const queueErrors = [];
    const queue = createBoundedQueue(async value => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (value === 3) throw new Error('expected test error');
      completedItems.push(value);
    }, {
      concurrency: 2,
      maxPending: 3,
      onError: (error, item) => queueErrors.push({ message: error.message, item })
    });

    for (let value = 0; value < 7; value += 1) await queue.enqueue(value);
    await queue.onIdle();
    assert.ok(maxActive <= 2, 'queue exceeded its concurrency limit');
    assert.deepEqual(completedItems.sort((a, b) => a - b), [0, 1, 2, 4, 5, 6]);
    assert.deepEqual(queueErrors.map(item => item.item), [3]);
    assert.equal(queue.snapshot().pending, 0);
    assert.equal(queue.snapshot().failed, 1);
  }

  console.log('scanner-resilience regression tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
