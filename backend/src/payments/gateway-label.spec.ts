import { gatewayLabel } from './gateway-label.js';

describe('gatewayLabel', () => {
  it.each([
    ['BKASH-BKash', 'bKash'],
    ['NAGAD-Nagad', 'Nagad'],
    ['VISA-Dutch Bangla', 'Visa'],
    ['MASTER-Brac bank', 'Mastercard'],
    ['AMEX-City Bank', 'Amex'],
    ['bkash-BKash', 'bKash'],
    ['DBBLMOBILEB-Dbbl Mobile Banking', 'DBBLMOBILEB'],
    ['UPAY', 'UPAY'],
  ])('%s → %s', (cardType, label) => {
    expect(gatewayLabel('SSLCOMMERZ', cardType)).toBe(label);
  });

  it.each([null, '', '-Bank', '  '])(
    'SSLCommerz without a usable card_type (%j) → SSLCommerz',
    (cardType) => {
      expect(gatewayLabel('SSLCOMMERZ', cardType)).toBe('SSLCommerz');
    },
  );

  it('৳0 rows → PROMOTION, whatever the card_type', () => {
    expect(gatewayLabel('PROMOTION', null)).toBe('PROMOTION');
    expect(gatewayLabel('PROMOTION', 'VISA-X')).toBe('PROMOTION');
  });
});
