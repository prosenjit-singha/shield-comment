import {
  firstWorkspaceName,
  parseWorkspaceName,
  slugify,
} from './first-workspace.js';

describe('first workspace helpers', () => {
  it('slugify: ASCII, max 40 chars + random 6-hex suffix', () => {
    expect(slugify("Rahim's Shop!")).toMatch(/^rahim-s-shop-[0-9a-f]{6}$/);
    expect(slugify('ঢাকা ফ্যাশন')).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(slugify('a'.repeat(100)).length).toBe(47);
    expect(slugify('Shop')).not.toBe(slugify('Shop'));
  });

  it('parseWorkspaceName: undefined when absent, null when invalid, trimmed otherwise', () => {
    expect(parseWorkspaceName({ name: 'x' })).toBeUndefined();
    expect(parseWorkspaceName(undefined)).toBeUndefined();
    expect(parseWorkspaceName({ workspaceName: '  Dhaka Fashion ' })).toBe(
      'Dhaka Fashion',
    );
    expect(parseWorkspaceName({ workspaceName: '   ' })).toBeNull();
    expect(parseWorkspaceName({ workspaceName: 'x'.repeat(81) })).toBeNull();
    expect(parseWorkspaceName({ workspaceName: 42 })).toBeNull();
  });

  it('firstWorkspaceName: workspaceName, else "<name>\'s workspace"', () => {
    expect(firstWorkspaceName({ name: 'Rahim', workspaceName: 'Shop' })).toBe(
      'Shop',
    );
    expect(firstWorkspaceName({ name: ' Rahim ' })).toBe("Rahim's workspace");
    expect(firstWorkspaceName({})).toBe('My workspace');
    expect(firstWorkspaceName({ name: 'n'.repeat(100) })).toHaveLength(80);
  });
});
