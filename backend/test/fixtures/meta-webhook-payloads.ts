/**
 * Meta webhook bodies shaped like the real deliveries (Graph v26 docs: Page `feed` and Instagram
 * `comments`; values trimmed to the fields the receiver reads + a few it ignores). Shared by the
 * envelope unit tests and the receiver e2e. Ids are fake but in Meta's formats.
 */

export const FB_PAGE_ID = '1000000000001';
export const FB_POST_ID = `${FB_PAGE_ID}_3000000000001`;
export const IG_BUSINESS_ID = '17841400000000001';
export const IG_MEDIA_ID = '18000000000000001';

type Json = Record<string, unknown>;

/** A Page `feed` comment change value (`item: comment`). */
export function fbCommentValue(overrides: Json = {}): Json {
  return {
    from: { id: '2000000000001', name: 'Rahim Uddin' },
    post: {
      status_type: 'added_photos',
      is_published: true,
      promotion_status: 'active',
      id: FB_POST_ID,
    },
    message: 'bKash e taka pathan 01700000000',
    post_id: FB_POST_ID,
    comment_id: '3000000000001_4000000000001',
    created_time: 1763479990,
    item: 'comment',
    parent_id: FB_POST_ID,
    verb: 'add',
    ...overrides,
  };
}

/** An IG `comments` change value (no verb: IG only delivers new comments). */
export function igCommentValue(overrides: Json = {}): Json {
  return {
    from: { id: '5000000000001', username: 'karim.shop' },
    media: { id: IG_MEDIA_ID, media_product_type: 'FEED' },
    id: '18100000000000001',
    text: 'Nagad e order korun',
    ...overrides,
  };
}

export interface ChangeFixture {
  field: string;
  value: unknown;
}

export function entry(
  id: string,
  changes: ChangeFixture[],
  time: unknown = 1763480000,
): Json {
  return { id, time, changes };
}

export function envelope(object: string, entries: Json[]): Json {
  return { object, entry: entries };
}

/** One Page with one `feed` change. */
export function fbPayload(value: Json = fbCommentValue()): Json {
  return envelope('page', [entry(FB_PAGE_ID, [{ field: 'feed', value }])]);
}

/** One IG account with one `comments` change. */
export function igPayload(value: Json = igCommentValue()): Json {
  return envelope('instagram', [
    entry(IG_BUSINESS_ID, [{ field: 'comments', value }]),
  ]);
}
