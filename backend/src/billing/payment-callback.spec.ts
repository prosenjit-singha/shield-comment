import {
  callbackTranId,
  isRetryOutcome,
  PAYMENT_OUTCOMES,
  paymentReturnUrl,
  successReturn,
  validationOutcome,
} from './payment-callback.js';

describe('payment callbacks (pure)', () => {
  const row = { tranId: 'SCabc12345', amountBdt: 1000 };
  const valid = {
    status: 'VALID' as const,
    tranId: 'SCabc12345',
    amount: 1000,
    currency: 'BDT',
    valId: 'V1',
    bankTranId: 'B1',
    cardType: 'BKASH-BKash',
    riskLevel: 0,
    token: null,
  };

  it('validationOutcome: all checks pass for VALID and VALIDATED', () => {
    expect(validationOutcome(valid, row)).toBeNull();
    expect(
      validationOutcome({ ...valid, status: 'VALIDATED' }, row),
    ).toBeNull();
  });

  it('validationOutcome: invalid, tran id, currency, amount (in that order)', () => {
    expect(
      validationOutcome({ status: 'INVALID_TRANSACTION', valId: 'V1' }, row),
    ).toBe('INVALID');
    expect(validationOutcome({ ...valid, tranId: 'SCother000' }, row)).toBe(
      'TRAN_ID_MISMATCH',
    );
    expect(validationOutcome({ ...valid, currency: 'USD' }, row)).toBe(
      'CURRENCY_MISMATCH',
    );
    expect(validationOutcome({ ...valid, amount: 999.99 }, row)).toBe(
      'AMOUNT_MISMATCH',
    );
    expect(validationOutcome({ ...valid, amount: 10 }, row)).toBe(
      'AMOUNT_MISMATCH',
    );
  });

  it('callbackTranId: 1–64 character strings only', () => {
    expect(callbackTranId({ tran_id: 'SCabc' })).toBe('SCabc');
    expect(callbackTranId({ tran_id: 'x'.repeat(64) })).toHaveLength(64);
    expect(callbackTranId({ tran_id: 'x'.repeat(65) })).toBeNull();
    expect(callbackTranId({ tran_id: '' })).toBeNull();
    expect(callbackTranId({ tran_id: ['a'] })).toBeNull();
    expect(callbackTranId({})).toBeNull();
  });

  it('successReturn + isRetryOutcome', () => {
    expect(successReturn(PAYMENT_OUTCOMES.paid)).toBe('success');
    expect(successReturn(PAYMENT_OUTCOMES.paidDuplicateClaim)).toBe('success');
    expect(successReturn(PAYMENT_OUTCOMES.alreadyPaid)).toBe('success');
    expect(successReturn(PAYMENT_OUTCOMES.amountMismatch)).toBe('failed');
    expect(successReturn(PAYMENT_OUTCOMES.badSignature)).toBe('failed');
    expect(successReturn(PAYMENT_OUTCOMES.validationError)).toBe('pending');
    expect(isRetryOutcome(PAYMENT_OUTCOMES.activationFailed)).toBe(true);
    expect(isRetryOutcome(PAYMENT_OUTCOMES.unknownTranId)).toBe(false);
  });

  it('paymentReturnUrl: /billing with payment + tranId, trailing slash trimmed', () => {
    expect(paymentReturnUrl('https://app.x.com/', 'success', 'SC1 2')).toBe(
      'https://app.x.com/billing?payment=success&tranId=SC1+2',
    );
    expect(paymentReturnUrl('https://app.x.com', 'failed', null)).toBe(
      'https://app.x.com/billing?payment=failed',
    );
  });
});
