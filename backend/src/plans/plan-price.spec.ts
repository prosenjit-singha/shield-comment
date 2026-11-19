import { type PlanPriceSource, planPrice } from './plan-price.js';

const starter: PlanPriceSource = {
  monthlyPriceBdt: 999,
  offerPriceBdt: 499,
  offerBadge: '50% Launch Offer',
  // Yearly list price since 0027 (PR-T1): ৳449 shown + the ৳500 launch offer.
  yearlyMonthlyPriceBdt: 949,
};

describe('planPrice (PW-T1b)', () => {
  it('monthly with an offer: per month = charged = the offer; list = original; badge kept', () => {
    expect(planPrice(starter, 'month')).toEqual({
      perMonthBdt: 499,
      chargedBdt: 499,
      listPerMonthBdt: 999,
      badge: '50% Launch Offer',
    });
  });

  it('monthly without an offer: the original price, no badge', () => {
    expect(
      planPrice({ ...starter, offerPriceBdt: null, offerBadge: null }, 'month'),
    ).toEqual({
      perMonthBdt: 999,
      chargedBdt: 999,
      listPerMonthBdt: 999,
      badge: null,
    });
  });

  it('a ৳0 offer is a price, not "no offer"', () => {
    expect(planPrice({ ...starter, offerPriceBdt: 0 }, 'month')).toMatchObject({
      perMonthBdt: 0,
      chargedBdt: 0,
    });
  });

  it('yearly: the per-month price, charged × 12, same list price + badge (PW-D5, PW-D6)', () => {
    expect(planPrice(starter, 'year')).toEqual({
      perMonthBdt: 449,
      chargedBdt: 5388,
      listPerMonthBdt: 999,
      badge: '50% Launch Offer',
    });
    expect(
      planPrice(
        {
          monthlyPriceBdt: 5999,
          offerPriceBdt: 3999,
          offerBadge: '33% Off',
          yearlyMonthlyPriceBdt: 5599,
        },
        'year',
      ),
    ).toMatchObject({ perMonthBdt: 3599, chargedBdt: 43188 });
  });

  it('yearly minus the offer saving (PR-T1 bridge): no offer = the yearly list price; floor ৳0', () => {
    expect(
      planPrice({ ...starter, offerPriceBdt: null, offerBadge: null }, 'year'),
    ).toMatchObject({ perMonthBdt: 949, chargedBdt: 11388 });
    expect(
      planPrice({ ...starter, yearlyMonthlyPriceBdt: 400 }, 'year'),
    ).toMatchObject({ perMonthBdt: 0, chargedBdt: 0 });
  });

  it('yearly without a yearly price → null (no yearly option)', () => {
    expect(
      planPrice({ ...starter, yearlyMonthlyPriceBdt: null }, 'year'),
    ).toBeNull();
    // The monthly price does not depend on it.
    expect(
      planPrice({ ...starter, yearlyMonthlyPriceBdt: null }, 'month'),
    ).toMatchObject({ perMonthBdt: 499 });
  });
});
