import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP baseline (19 MiB, 2 passes, 1 lane). The algorithm is the library default, argon2id
 * (its `Algorithm` const enum can't be imported under isolatedModules); a unit test pins it.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  /** Never throws: a malformed or foreign hash simply fails verification. */
  async verify(passwordHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plain);
    } catch {
      return false;
    }
  }
}
