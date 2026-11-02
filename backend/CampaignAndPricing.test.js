const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlayStoreUrl } = require('./PlayStoreIntelligence');

describe('Play Store URL & Package Validation', () => {
  test('validates single game Play Store URL', () => {
    const url = 'https://play.google.com/store/apps/details?id=com.rovio.angrybirds';
    const res = validatePlayStoreUrl(url);
    assert.equal(res.valid, true);
    assert.equal(res.type, 'game');
    assert.equal(res.packageName, 'com.rovio.angrybirds');
    assert.equal(res.normalizedUrl, 'https://play.google.com/store/apps/details?id=com.rovio.angrybirds');
  });

  test('validates single game Play Store URL with additional query params', () => {
    const url = 'https://play.google.com/store/apps/details?id=com.voodoo.paperio2&hl=en&gl=US';
    const res = validatePlayStoreUrl(url);
    assert.equal(res.valid, true);
    assert.equal(res.type, 'game');
    assert.equal(res.packageName, 'com.voodoo.paperio2');
  });

  test('validates raw Android package name', () => {
    const pkg = 'com.supercell.clashroyale';
    const res = validatePlayStoreUrl(pkg);
    assert.equal(res.valid, true);
    assert.equal(res.type, 'game');
    assert.equal(res.packageName, 'com.supercell.clashroyale');
  });

  test('validates publisher developer URL by ID', () => {
    const url = 'https://play.google.com/store/apps/developer?id=Lion+Gamez+Studio';
    const res = validatePlayStoreUrl(url);
    assert.equal(res.valid, true);
    assert.equal(res.type, 'publisher');
    assert.equal(res.publisher, 'Lion Gamez Studio');
  });

  test('validates publisher developer URL with dev?id', () => {
    const url = 'https://play.google.com/store/apps/dev?id=5700313618786177705';
    const res = validatePlayStoreUrl(url);
    assert.equal(res.valid, true);
    assert.equal(res.type, 'publisher');
    assert.equal(res.developerId, '5700313618786177705');
  });

  test('rejects empty or malformed strings', () => {
    assert.equal(validatePlayStoreUrl('').valid, false);
    assert.equal(validatePlayStoreUrl('   ').valid, false);
    assert.equal(validatePlayStoreUrl('https://example.com/not-play').valid, false);
  });
});

describe('Pricing & Pre-registration Classification', () => {
  // Pure pricing logic test matching PlayStoreIntelligence rules
  function classifyPrice(appItem) {
    const isPaid = appItem.free === false && Number(appItem.price) > 0;
    const priceNum = isPaid && Number.isFinite(Number(appItem.price)) ? Number(appItem.price) : null;
    const priceText = isPaid ? (appItem.priceText || (priceNum ? `$${priceNum}` : null)) : 'Free';
    return { isPaid, priceNum, priceText };
  }

  test('Standard free game is classified as free', () => {
    const item = { free: true, price: 0, priceText: null };
    const res = classifyPrice(item);
    assert.equal(res.isPaid, false);
    assert.equal(res.priceNum, null);
    assert.equal(res.priceText, 'Free');
  });

  test('Pre-registration game with free: false and price: 0 is correctly classified as Free (NOT Paid)', () => {
    // This was the bug: free: false was causing $0.00 to show as Paid
    const item = { free: false, price: 0, priceText: '$0.00' };
    const res = classifyPrice(item);
    assert.equal(res.isPaid, false);
    assert.equal(res.priceNum, null);
    assert.equal(res.priceText, 'Free');
  });

  test('Genuinely paid game is correctly classified as Paid with price', () => {
    const item = { free: false, price: 1.79, priceText: '$1.79' };
    const res = classifyPrice(item);
    assert.equal(res.isPaid, true);
    assert.equal(res.priceNum, 1.79);
    assert.equal(res.priceText, '$1.79');
  });

  test('Game with string zero price "0" or "0.00" is free', () => {
    const item = { free: false, price: '0.00', priceText: '$0.00' };
    const res = classifyPrice(item);
    assert.equal(res.isPaid, false);
    assert.equal(res.priceNum, null);
    assert.equal(res.priceText, 'Free');
  });
});
