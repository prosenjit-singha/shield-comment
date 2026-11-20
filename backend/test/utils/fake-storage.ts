import type { StorageService } from '../../src/storage/storage.service.js';

export interface FakeStorageService {
  /** Mirrors `StorageService.enabled`; set `false` to act as "storage not configured". */
  enabled: boolean;
  put: StorageService['put'];
  delete: StorageService['delete'];
  get: StorageService['get'];
  presignGet: StorageService['presignGet'];
  presignPut: StorageService['presignPut'];
  /** Stored objects by key. */
  readonly objects: Map<string, { body: Uint8Array; contentType?: string }>;
  /** Calls nobody expected (each also threw); assert it stays empty. */
  readonly unexpected: string[];
  /** Arms `count` puts. */
  expectPuts(count: number): FakeStorageService;
  /** Armed puts not used yet. */
  readonly pendingPuts: number;
}

/**
 * Strict in-memory stand-in for `StorageService` (M7-T3): no network. `put` must be armed with
 * `expectPuts(n)`; `presignGet` works only for stored keys (`https://storage.test/<key>?…`);
 * `delete`, `get` and `presignPut` are never expected. An unexpected call throws and lands in
 * `unexpected`. Wire it with `.overrideProvider(StorageService).useValue(createStorageFake())`.
 */
export function createStorageFake(): FakeStorageService {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const unexpected: string[] = [];
  let armedPuts = 0;
  const fail = (call: string): never => {
    unexpected.push(call);
    throw new Error(`Unexpected StorageService call in this spec: ${call}`);
  };
  const fake: FakeStorageService = {
    enabled: true,
    async put(key, body, options = {}) {
      if (!fake.enabled || armedPuts === 0) return fail(`put ${key}`);
      armedPuts -= 1;
      objects.set(key, {
        body: typeof body === 'string' ? Buffer.from(body) : body,
        contentType: options.contentType,
      });
    },
    async presignGet(key, expiresInSeconds = 900) {
      if (!fake.enabled || !objects.has(key)) return fail(`presignGet ${key}`);
      return `https://storage.test/${key}?X-Amz-Expires=${expiresInSeconds}`;
    },
    delete: async (key) => fail(`delete ${key}`),
    get: async (key) => fail(`get ${key}`),
    presignPut: async (key) => fail(`presignPut ${key}`),
    objects,
    unexpected,
    expectPuts(count) {
      armedPuts += count;
      return fake;
    },
    get pendingPuts() {
      return armedPuts;
    },
  };
  return fake;
}
