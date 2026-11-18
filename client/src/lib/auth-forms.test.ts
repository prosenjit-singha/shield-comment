import { describe, expect, it } from 'vitest'
import { fieldErrorMessage, validateSignIn, validateSignUp, type SignUpInput } from '@/lib/auth-forms'

const valid: SignUpInput = { name: 'Rahim', email: 'rahim@shop.bd', password: '12345678', businessName: 'Rahim Fashion' }

describe('validateSignIn', () => {
  it('needs an email-shaped address and a password', () => {
    expect(validateSignIn({ email: '', password: '' })).toEqual({ email: 'required', password: 'required' })
    expect(validateSignIn({ email: 'rahim@shop', password: 'x' })).toEqual({ email: 'invalid-email' })
    expect(validateSignIn({ email: ' rahim@shop.bd ', password: 'x' })).toEqual({})
  })
})

describe('validateSignUp', () => {
  it('passes a valid form', () => {
    expect(validateSignUp(valid)).toEqual({})
  })

  it('requires every field (whitespace-only counts as empty for names)', () => {
    expect(validateSignUp({ name: '  ', email: '', password: '', businessName: '   ' })).toEqual({
      name: 'required',
      email: 'required',
      password: 'required',
      businessName: 'required',
    })
  })

  it('applies Better Auth password length 8–128', () => {
    expect(validateSignUp({ ...valid, password: '1234567' }).password).toBe('too-short')
    expect(validateSignUp({ ...valid, password: 'x'.repeat(128) }).password).toBeUndefined()
    expect(validateSignUp({ ...valid, password: 'x'.repeat(129) }).password).toBe('too-long')
  })

  it('matches parseWorkspaceName: trimmed business name of 1–80 characters', () => {
    expect(validateSignUp({ ...valid, businessName: ` ${'a'.repeat(80)} ` }).businessName).toBeUndefined()
    expect(validateSignUp({ ...valid, businessName: 'a'.repeat(81) }).businessName).toBe('too-long')
  })
})

describe('fieldErrorMessage', () => {
  it('names the limit that was broken, in both languages', () => {
    const en = (english: string) => english
    const bn = (_english: string, bangla: string) => bangla
    expect(fieldErrorMessage('password', 'too-long', en)).toBe('Use at most 128 characters.')
    expect(fieldErrorMessage('businessName', 'too-long', en)).toBe('Use at most 80 characters.')
    expect(fieldErrorMessage('businessName', 'too-long', bn)).toBe('সর্বোচ্চ ৮০ অক্ষর ব্যবহার করুন।')
    expect(fieldErrorMessage('name', 'required', bn)).toBe('আপনার নাম লিখুন।')
  })
})
