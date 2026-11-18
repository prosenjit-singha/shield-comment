import {
  type ExistingPageOwnership,
  planPageSync,
  type SocialPageSyncInput,
} from './social-pages.sync.js';

const WS = '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c';
const OTHER = '0192f5a4-0000-7000-8000-000000000000';

const page = (
  pageId: string,
  igBusinessId: string | null = null,
): SocialPageSyncInput => ({
  pageId,
  pageName: `Page ${pageId}`,
  igBusinessId,
  igUsername: igBusinessId ? `ig${igBusinessId}` : null,
  encryptedPageAccessToken: `v1:unit:${pageId}`,
});

const row = (
  id: string,
  workspaceId: string,
  pageId: string,
  igBusinessId: string | null = null,
): ExistingPageOwnership => ({ id, workspaceId, pageId, igBusinessId });

describe('planPageSync (D7/D10)', () => {
  it('first connect: every Page is upserted, nothing skipped', () => {
    const plan = planPageSync(WS, [page('1', '91'), page('2')], []);
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['1', '2']);
    expect(plan.skipped).toEqual([]);
    expect(plan.detachIgRowIds).toEqual([]);
    expect(plan.listedPageIds).toEqual(['1', '2']);
  });

  it('Pages already in this workspace are upserted (matched case-insensitively)', () => {
    const plan = planPageSync(
      WS,
      [page('1', '91')],
      [row('r1', WS.toUpperCase(), '1', '91')],
    );
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['1']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips a Page owned by another workspace', () => {
    const plan = planPageSync(
      WS,
      [page('1'), page('2')],
      [row('r1', OTHER, '1')],
    );
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['2']);
    expect(plan.skipped).toEqual([
      { pageId: '1', reason: 'page_in_other_workspace' },
    ]);
    // Still "listed": not treated as missing.
    expect(plan.listedPageIds).toEqual(['1', '2']);
  });

  it('skips a Page whose IG account belongs to another workspace', () => {
    const plan = planPageSync(
      WS,
      [page('1', '91'), page('2', '92')],
      [row('r9', OTHER, '9', '91')],
    );
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['2']);
    expect(plan.skipped).toEqual([
      { pageId: '1', reason: 'instagram_in_other_workspace' },
    ]);
  });

  it('leaves a Page of this workspace alone when its new IG account is held elsewhere', () => {
    const plan = planPageSync(
      WS,
      [page('1', '91')],
      [row('r1', WS, '1', '90'), row('r9', OTHER, '9', '91')],
    );
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toEqual([
      { pageId: '1', reason: 'instagram_in_other_workspace' },
    ]);
    expect(plan.listedPageIds).toEqual(['1']);
    expect(plan.detachIgRowIds).toEqual([]);
  });

  it('same IG listed on two Pages: first wins, second skipped', () => {
    const plan = planPageSync(WS, [page('1', '91'), page('2', '91')], []);
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['1']);
    expect(plan.skipped).toEqual([
      { pageId: '2', reason: 'duplicate_instagram' },
    ]);
  });

  it('a repeated Page id is synced once', () => {
    const plan = planPageSync(WS, [page('1'), page('1')], []);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.listedPageIds).toEqual(['1']);
  });

  it('detaches an IG account that moved to another Page of this workspace (incl. swaps)', () => {
    const plan = planPageSync(
      WS,
      [page('1', '92'), page('2', '91'), page('3', '93')],
      [
        row('r1', WS, '1', '91'),
        row('r2', WS, '2', '92'),
        row('r3', WS, '3', '93'),
        row('r4', WS, '4', '94'),
      ],
    );
    expect(plan.upserts).toHaveLength(3);
    expect(plan.detachIgRowIds.sort()).toEqual(['r1', 'r2']);
  });

  it('detaches an IG account from a missing Page of this workspace when another Page now has it', () => {
    const plan = planPageSync(
      WS,
      [page('2', '91')],
      [row('r1', WS, '1', '91')],
    );
    expect(plan.upserts.map((p) => p.pageId)).toEqual(['2']);
    expect(plan.detachIgRowIds).toEqual(['r1']);
    expect(plan.listedPageIds).toEqual(['2']);
  });

  it('never detaches another workspace’s rows', () => {
    const plan = planPageSync(
      WS,
      [page('2', '91')],
      [row('r1', OTHER, '1', '91')],
    );
    expect(plan.detachIgRowIds).toEqual([]);
    expect(plan.upserts).toEqual([]);
  });

  it('no Pages from Meta: nothing upserted, nothing listed (every row of this workspace is missing)', () => {
    const plan = planPageSync(WS, [], [row('r1', WS, '1', '91')]);
    expect(plan).toEqual({
      upserts: [],
      skipped: [],
      detachIgRowIds: [],
      listedPageIds: [],
    });
  });
});
