import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import {
  type MetaOAuthStateData,
  metaOAuthStateKey,
  parseMetaOAuthStateData,
} from './meta-oauth-state.js';

/**
 * Where OAuth states live (D6: Redis, TTL, single use). Abstract class = DI token; e2e overrides it
 * with an in-memory store (Redis is stubbed there).
 */
export abstract class MetaOAuthStateStore {
  /** Stores `data` under `state` for `ttlSeconds`. */
  abstract save(
    state: string,
    data: MetaOAuthStateData,
    ttlSeconds: number,
  ): Promise<void>;

  /** Reads and deletes in one step; `null` when missing, expired, already used or corrupt. */
  abstract take(state: string): Promise<MetaOAuthStateData | null>;
}

@Injectable()
export class RedisMetaOAuthStateStore extends MetaOAuthStateStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async save(
    state: string,
    data: MetaOAuthStateData,
    ttlSeconds: number,
  ): Promise<void> {
    const client = await this.connected();
    // NX: a (practically impossible) collision must not overwrite someone else's state.
    const reply = await client.set(
      metaOAuthStateKey(state),
      JSON.stringify(data),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (reply !== 'OK') throw new Error('OAuth state key already exists');
  }

  async take(state: string): Promise<MetaOAuthStateData | null> {
    const client = await this.connected();
    // GETDEL (Redis ≥ 6.2): atomic, so two callbacks with the same state can't both pass.
    return parseMetaOAuthStateData(
      await client.getdel(metaOAuthStateKey(state)),
    );
  }

  private async connected() {
    const { client } = this.redis;
    if (client.status === 'wait') await client.connect();
    return client;
  }
}
