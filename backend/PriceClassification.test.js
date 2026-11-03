const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRICE_STATUS,
  RELEASE_STATUS,
  PRICE_SOURCE,
  classifyPlayPrice,
  detectMonetizationHint,
  resolveEffectivePricing
} = require('./PriceClassification');

describe('Scenario 1: Pre-reg with zero-price placeholder and no monetization evidence', () => {
  test('classifies as PRICE_TBA with hint NONE', () => {
    const offer = { preregister: true, offerMicros: 0, currency: 'USD', priceText: '' };
    const desc = ['Master car parking skills and drive modern cars in 3D plaza levels! Complete parking challenges.'];
    const res = classifyPlayPrice(offer, desc);

    assert.equal(res.release_status, RELEASE_STATUS.PRE_REGISTERED);
    assert.equal(res.price_status, PRICE_STATUS.PRICE_TBA);
    assert.equal(res.monetization_hint, 'NONE');
    assert.equal(res.monetization_hint_evidence, null);
    assert.equal(res.price, null);
  });
});

describe('Scenario 2: Pre-reg with zero-price placeholder and launch-discount statement', () => {
  test('classifies as PRICE_TBA with hint LIKELY_PAID and extracts exact evidence', () => {
    const offer = { preregister: true, offerMicros: 0, currency: 'PKR', priceText: '' };
    const desc = [
      'Pre-register now and enjoy 10% off during the first two weeks after launch.',
      'Defend the castle gate against goblins and royal visitors.'
    ];
    const res = classifyPlayPrice(offer, desc);

    assert.equal(res.release_status, RELEASE_STATUS.PRE_REGISTERED);
    assert.equal(res.price_status, PRICE_STATUS.PRICE_TBA);
    assert.equal(res.monetization_hint, 'LIKELY_PAID');
    assert.match(res.monetization_hint_evidence, /10%\s*off/i);
    assert.equal(res.monetization_hint_rule, 'percent_off_launch');
  });
});

describe('Scenario 3: Pre-reg with zero-price placeholder and explicit premium/pay-once language', () => {
  test('classifies as PRICE_TBA with hint LIKELY_PAID from pay-once language', () => {
    const offer = { preregister: true, offerMicros: null };
    const desc = ['A hand-drawn detective mystery. Pay once to unlock the full premium game with no ads or microtransactions.'];
    const res = classifyPlayPrice(offer, desc);

    assert.equal(res.release_status, RELEASE_STATUS.PRE_REGISTERED);
    assert.equal(res.price_status, PRICE_STATUS.PRICE_TBA);
    assert.equal(res.monetization_hint, 'LIKELY_PAID');
    assert.ok(res.monetization_hint_rule === 'pay_once' || res.monetization_hint_rule === 'premium_title');
    assert.match(res.monetization_hint_evidence, /Pay once/i);
  });
});

describe('Scenario 4: Pre-reg game manually marked Paid -> Paid (Manual), retained after rescanning', () => {
  test('manual override yields Paid (Manual) and survives automatic scan classification', () => {
    // 1. Initial automatic pre-reg scan: PRICE_TBA
    const autoScan = classifyPlayPrice({ preregister: true, offerMicros: 0, currency: 'USD' }, []);
    assert.equal(autoScan.price_status, PRICE_STATUS.PRICE_TBA);

    // 2. Admin sets manual override to PAID
    const rowWithManual = {
      price_status: autoScan.price_status,
      manual_price_status: 'PAID',
      manual_price_note: 'Verified with developer on Discord',
      manual_price_by: 'admin'
    };

    const effectiveBefore = resolveEffectivePricing(rowWithManual);
    assert.equal(effectiveBefore.effective_price_status, 'PAID');
    assert.equal(effectiveBefore.pricing, 'paid');
    assert.equal(effectiveBefore.is_manual, true);
    assert.equal(effectiveBefore.classification_source, PRICE_SOURCE.MANUAL);

    // 3. Re-scan occurs while still in pre-registration: automatic is still PRICE_TBA
    const rescan = classifyPlayPrice({ preregister: true, offerMicros: 0, currency: 'USD' }, []);
    rowWithManual.price_status = rescan.price_status; // scan updates automatic, leaves manual_price_status untouched

    const effectiveAfter = resolveEffectivePricing(rowWithManual);
    assert.equal(effectiveAfter.effective_price_status, 'PAID');
    assert.equal(effectiveAfter.pricing, 'paid');
    assert.equal(effectiveAfter.is_manual, true);
  });
});

describe('Scenario 5: Pre-reg game that launches with a valid positive price', () => {
  test('classifies as PAID with actual price and currency and LIVE status', () => {
    const launchOffer = {
      preregister: false,
      offerMicros: 4990000,
      currency: 'USD',
      priceText: '$4.99'
    };
    const res = classifyPlayPrice(launchOffer, ['Game is now live on Google Play!']);

    assert.equal(res.release_status, RELEASE_STATUS.LIVE);
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.equal(res.price, 4.99);
    assert.equal(res.currency, 'USD');
    assert.equal(res.price_text, '$4.99');
    assert.equal(res.price_source, PRICE_SOURCE.PLAY_STORE_PRICE);
  });
});

describe('Scenario 6: Live game explicitly verified as free', () => {
  test('classifies as FREE with explicit zero offer and LIVE status', () => {
    const freeOffer = {
      preregister: false,
      offerMicros: 0,
      currency: 'USD',
      priceText: 'Free'
    };
    const res = classifyPlayPrice(freeOffer, ['Free to play endless runner']);

    assert.equal(res.release_status, RELEASE_STATUS.LIVE);
    assert.equal(res.price_status, PRICE_STATUS.FREE);
    assert.equal(res.price, null);
    assert.equal(res.price_text, 'Free');
    assert.equal(res.price_source, PRICE_SOURCE.PLAY_STORE_PRICE);
  });
});

describe('Scenario 7: Live game with missing or ambiguous price information', () => {
  test('classifies as UNKNOWN instead of guessing Free or Paid', () => {
    const ambiguousOffer = {
      preregister: false,
      offerMicros: null, // No offer block returned
      currency: null,
      priceText: null
    };
    const res = classifyPlayPrice(ambiguousOffer, ['Title listing with delisted/empty store offer']);

    assert.equal(res.release_status, RELEASE_STATUS.LIVE);
    assert.equal(res.price_status, PRICE_STATUS.UNKNOWN);
    assert.equal(res.price, null);
    assert.equal(res.price_source, PRICE_SOURCE.UNKNOWN);
  });
});

describe('Scenario 8: Manual override is cleared -> automatic classification resumes', () => {
  test('clearing manual override restores automatic classification', () => {
    const row = {
      price_status: PRICE_STATUS.PRICE_TBA,
      price_source: PRICE_SOURCE.UNKNOWN,
      manual_price_status: 'PAID'
    };

    const before = resolveEffectivePricing(row);
    assert.equal(before.effective_price_status, 'PAID');
    assert.equal(before.is_manual, true);

    // Clear override
    row.manual_price_status = null;
    const after = resolveEffectivePricing(row);
    assert.equal(after.effective_price_status, PRICE_STATUS.PRICE_TBA);
    assert.equal(after.pricing, 'tba');
    assert.equal(after.is_manual, false);
  });
});

describe('Scenario 9: Games with $0.00 price or on-offer promotions are classified as Paid', () => {
  test('game with $0.00 priceText and free: false is classified as PAID (on offer)', () => {
    const offer = {
      preregister: false,
      free: false,
      offerMicros: 0,
      currency: 'USD',
      priceText: '$0.00'
    };
    const res = classifyPlayPrice(offer, ['Popular arcade game on limited-time offer']);
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.notEqual(res.price_status, PRICE_STATUS.FREE);
    assert.match(res.price_text, /Offer|\$0\.00/i);
  });

  test('game with originalPrice is classified as PAID with regular price preserved', () => {
    const offer = {
      preregister: false,
      offerMicros: 0,
      originalMicros: 2990000,
      currency: 'USD',
      priceText: '$0.00'
    };
    const res = classifyPlayPrice(offer, []);
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.equal(res.price, 2.99);
    assert.match(res.price_text, /2\.99/);
  });

  test('previously paid game re-scanned with zero price is NOT downgraded to free', () => {
    const freshZeroOffer = {
      preregister: false,
      offerMicros: 0,
      currency: 'USD',
      priceText: 'Free'
    };
    const existingGame = {
      price_status: PRICE_STATUS.PAID,
      is_paid: true,
      price: 1.99,
      currency: 'USD'
    };
    const res = classifyPlayPrice(freshZeroOffer, [], existingGame);
    assert.equal(res.price_status, PRICE_STATUS.PAID);
    assert.equal(res.price, 1.99);
    assert.notEqual(res.price_status, PRICE_STATUS.FREE);
  });
});

describe('Regression test case: com.pid.lilguardsman', () => {
  test('accurately classifies com.pid.lilguardsman payload and description evidence', () => {
    const livePlayStorePayload = {
      preregister: true,
      offerMicros: 0,
      currency: 'PKR',
      priceText: ''
    };
    const livePlayStoreDescription = [
      'Pre-register now and enjoy 10% off during the first two weeks after launch.',
      'Lil’ Guardsman is a narrative comedy deduction game where you interrogate quirky fantasy characters.'
    ];

    const classification = classifyPlayPrice(livePlayStorePayload, livePlayStoreDescription);

    assert.equal(classification.release_status, 'PRE_REGISTERED');
    assert.equal(classification.price_status, 'PRICE_TBA');
    assert.equal(classification.monetization_hint, 'LIKELY_PAID');
    assert.equal(
      classification.monetization_hint_evidence,
      'Pre-register now and enjoy 10% off during the first two weeks after launch.'
    );
    assert.equal(classification.price, null);

    const effective = resolveEffectivePricing(classification);
    assert.equal(effective.pricing, 'tba');
    assert.equal(effective.effective_price_status, 'PRICE_TBA');
  });
});
