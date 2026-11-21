import { checkNeonBranch, neonEndpointId } from './neon-branch.js';

const host = (ep: string) => `${ep}.c-2.ap-southeast-1.aws.neon.tech`;
const url = (h: string) =>
  `postgresql://owner:s3cret@${h}/neondb?sslmode=require`;
const staging = 'ep-morning-meadow-a17o9g0x';
const production = 'ep-bold-dawn-a1xh3drl';

describe('neonEndpointId', () => {
  it('reads the endpoint id from pooled and direct hosts', () => {
    expect(neonEndpointId(url(host(`${staging}-pooler`)))).toBe(staging);
    expect(neonEndpointId(url(host(staging)))).toBe(staging);
  });

  it('returns undefined for local and invalid URLs', () => {
    expect(neonEndpointId(url('localhost:5432'))).toBeUndefined();
    expect(neonEndpointId('not a url')).toBeUndefined();
  });
});

describe('checkNeonBranch', () => {
  it('passes when both URLs are on the branch endpoint', () => {
    expect(
      checkNeonBranch({
        NEON_BRANCH: 'staging',
        DATABASE_URL: url(host(`${staging}-pooler`)),
        DIRECT_URL: url(host(staging)),
      }),
    ).toBeNull();
    expect(
      checkNeonBranch({
        NEON_BRANCH: 'production',
        DATABASE_URL: url(host(`${production}-pooler`)),
      }),
    ).toBeNull();
  });

  it('refuses the endpoint of the other branch, without printing the URL', () => {
    const error = checkNeonBranch({
      NEON_BRANCH: 'staging',
      DATABASE_URL: url(host(`${production}-pooler`)),
    });
    expect(error).toContain(production);
    expect(error).not.toContain('s3cret');
    expect(
      checkNeonBranch({
        NEON_BRANCH: 'staging',
        DATABASE_URL: url(host(staging)),
        DIRECT_URL: url(host(production)),
      }),
    ).toMatch(/^DIRECT_URL points at ep-bold-dawn/);
  });

  it('refuses a missing DATABASE_URL', () => {
    expect(
      checkNeonBranch({
        NEON_BRANCH: 'production',
        DIRECT_URL: url(host(production)),
      }),
    ).toBe('DATABASE_URL is not set');
  });

  it('refuses a local (non-Neon) URL when NEON_BRANCH is set', () => {
    expect(
      checkNeonBranch({
        NEON_BRANCH: 'staging',
        DATABASE_URL: url('localhost:5432'),
      }),
    ).toMatch(/non-Neon host/);
  });

  it('refuses a missing or unknown NEON_BRANCH', () => {
    const DATABASE_URL = url(host(staging));
    expect(checkNeonBranch({ DATABASE_URL })).toMatch(/^NEON_BRANCH must be/);
    expect(checkNeonBranch({ NEON_BRANCH: 'main', DATABASE_URL })).toMatch(
      /"main"/,
    );
  });
});
