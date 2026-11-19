import { monthsLeft, monthsOf, monthsThisTerm } from './discount-months.js';

const perMonth = (durationMonths: number | null) => ({
  discountScope: 'PER_MONTH' as const,
  durationMonths,
});
const total = { discountScope: 'TOTAL' as const, durationMonths: 3 };

describe('discount months (PR-T3b, reading 9)', () => {
  it('monthsLeft: N − used (floor 0), forever null, TOTAL only before its first bill', () => {
    expect(monthsLeft(perMonth(3), 0)).toBe(3);
    expect(monthsLeft(perMonth(3), 2)).toBe(1);
    expect(monthsLeft(perMonth(3), 3)).toBe(0);
    expect(monthsLeft(perMonth(3), 5)).toBe(0);
    expect(monthsLeft(perMonth(null), 40)).toBeNull();
    expect(monthsLeft(total, 0)).toBeNull();
    expect(monthsLeft(total, 1)).toBe(0);
  });

  it('monthsThisTerm: monthly 1, yearly min(12, left), forever / TOTAL the whole term', () => {
    expect(monthsThisTerm(perMonth(3), 0, 1)).toBe(1);
    expect(monthsThisTerm(perMonth(3), 1, 12)).toBe(2);
    expect(monthsThisTerm(perMonth(24), 0, 12)).toBe(12);
    expect(monthsThisTerm(perMonth(3), 3, 1)).toBe(0);
    expect(monthsThisTerm(perMonth(null), 7, 12)).toBe(12);
    expect(monthsThisTerm(total, 0, 12)).toBe(12);
    expect(monthsThisTerm(total, 0, 1)).toBe(1);
  });

  it('monthsOf: "k of N" for N-month PER_MONTH discounts only', () => {
    expect(monthsOf(perMonth(3), 0, 1)).toEqual({ from: 1, to: 1, of: 3 });
    expect(monthsOf(perMonth(3), 1, 1)).toEqual({ from: 2, to: 2, of: 3 });
    expect(monthsOf(perMonth(3), 1, 12)).toEqual({ from: 2, to: 3, of: 3 });
    expect(monthsOf(perMonth(null), 0, 1)).toBeNull();
    expect(monthsOf(total, 0, 12)).toBeNull();
  });
});
