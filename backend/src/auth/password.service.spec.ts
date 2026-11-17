import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id and never stores the plain password', async () => {
    const hash = await passwords.hash('s3cret-Pass!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('s3cret-Pass!');
  });

  it('salts every hash, so the same password hashes differently', async () => {
    const [a, b] = await Promise.all([
      passwords.hash('same-password'),
      passwords.hash('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await passwords.hash('correct horse');
    await expect(passwords.verify(hash, 'correct horse')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'wrong horse')).resolves.toBe(false);
  });

  it('returns false (does not throw) for a malformed hash', async () => {
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
