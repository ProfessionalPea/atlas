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
  const { classifyPlayPrice, offerFromGplayApp, PRICE_STATUS } = require('./PriceClassification');

  test('Standard free game is classified as free', () => {
    const item = { free: true, price: 0, priceText: 'Free' };
    const res = classifyPlayPrice(offerFromGplayApp(item));
    assert.equal(res.price_status, PRICE_STATUS.FREE);
    assert.equal(res.price, null);
    assert.equal(res.price_text, 'Free');
  });

  test('Pre-registration game with price 0 is classified as PRICE_TBA (NOT free)', () => {
    const item = { preregister: true, free: false, price: 0, priceText: '$0.00' };
    const res = classifyPlayPrice(offerFromGplayApp(item));
    assert.equal(res.price_status, PRICE_STATUS.PRICE_TBA);
    assert.notEqual(res.price_status, PRICE_STATUS.FREE);
  });

  test('Genuinely paid game is correctly classified as Paid with price', () => {
    const item = { free: false, price: 1.79, priceText: '$1.79' };
    const res = classifyPlayPrice(offerFromGplayApp(item));
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.equal(res.price, 1.79);
    assert.equal(res.price_text, '$1.79');
  });

  test('Live game with price 0.00 or $0.00 offer is NOT marked as free (still a paid game on offer)', () => {
    const item = { free: false, price: 0, priceText: '$0.00' };
    const res = classifyPlayPrice(offerFromGplayApp(item));
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.match(res.price_text, /Offer|\$0\.00/i);
    assert.notEqual(res.price_status, PRICE_STATUS.FREE);
  });

  test('Live game on 100% off promotion with originalPrice is classified as Paid', () => {
    const item = { free: true, price: 0, originalPrice: 2.99, priceText: '$0.00' };
    const res = classifyPlayPrice(offerFromGplayApp(item));
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.equal(res.price, 2.99);
  });
});
