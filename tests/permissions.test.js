import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  PORTAL_ADMIN_PERMS,
  portalPreviewPerms,
  hasPermission,
  permissionsInclude,
  isValidPermission,
} from '../api/_lib/permissions.js';

describe('PERMISSIONS catalog', () => {
  it('has unique, non-empty slugs', () => {
    const slugs = PERMISSIONS.map(p => p.slug);
    expect(slugs.length).toBeGreaterThan(0);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
  it('each entry has a group + label', () => {
    for (const p of PERMISSIONS) {
      expect(p.group).toBeTruthy();
      expect(p.label).toBeTruthy();
    }
  });
});

describe('isValidPermission', () => {
  it('accepts the wildcard', () => {
    expect(isValidPermission('*')).toBe(true);
  });
  it('accepts catalog slugs', () => {
    expect(isValidPermission('users.manage')).toBe(true);
    expect(isValidPermission('deals.manage_all')).toBe(true);
  });
  it('rejects unknown slugs', () => {
    expect(isValidPermission('users.haxx')).toBe(false);
    expect(isValidPermission('')).toBe(false);
    expect(isValidPermission(null)).toBe(false);
  });
  it('includes the voiceover catalogue permission', () => {
    expect(isValidPermission('voiceovers.manage')).toBe(true);
  });
});

describe('voiceovers.manage', () => {
  it('is granted to a role that holds it, and via wildcard', () => {
    expect(hasPermission({ permissions: ['voiceovers.manage'] }, 'voiceovers.manage')).toBe(true);
    expect(hasPermission({ permissions: ['*'] }, 'voiceovers.manage')).toBe(true);
  });
  it('is not granted by settings.manage alone (checked separately at the gate)', () => {
    expect(hasPermission({ permissions: ['settings.manage'] }, 'voiceovers.manage')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('wildcard grants every slug', () => {
    const role = { permissions: ['*'] };
    expect(hasPermission(role, 'users.manage')).toBe(true);
    expect(hasPermission(role, 'deals.manage_all')).toBe(true);
    expect(hasPermission(role, 'anything.at_all')).toBe(true);
  });
  it('explicit grant matches only that slug', () => {
    const role = { permissions: ['users.manage', 'roles.manage'] };
    expect(hasPermission(role, 'users.manage')).toBe(true);
    expect(hasPermission(role, 'roles.manage')).toBe(true);
    expect(hasPermission(role, 'deals.manage_all')).toBe(false);
  });
  it('empty array grants nothing', () => {
    const role = { permissions: [] };
    expect(hasPermission(role, 'users.manage')).toBe(false);
  });
  it('null role grants nothing', () => {
    expect(hasPermission(null, 'users.manage')).toBe(false);
    expect(hasPermission(undefined, 'users.manage')).toBe(false);
  });
  it('malformed permissions field is treated as empty', () => {
    expect(hasPermission({ permissions: null }, 'x.y')).toBe(false);
    expect(hasPermission({ permissions: 'admin' }, 'x.y')).toBe(false);
  });
});

// Opening a client's portal. The split matters: a shared preview link resolves
// against whoever opens it, so the delivery team can look — but looking must
// never be a route into editing the client's account.
describe('portalPreviewPerms', () => {
  const producer = { permissions: ['portal.preview', 'schedule.access', 'production.access'] };
  const projectManager = { permissions: ['portal.preview', 'deals.manage_all'] };
  const copywriter = { permissions: ['schedule.access'] };
  const admin = { permissions: ['*'] };
  const allows = (role, manage) => portalPreviewPerms(manage).some((p) => hasPermission(role, p));

  it('lets a producer view a preview', () => {
    expect(allows(producer, false)).toBe(true);
  });

  it('does NOT let a producer into manage mode', () => {
    expect(allows(producer, true)).toBe(false);
  });

  it('lets a project manager do both (they hold deals.manage_all)', () => {
    expect(allows(projectManager, false)).toBe(true);
    expect(allows(projectManager, true)).toBe(true);
  });

  // A Production Manager runs client delivery but isn't an editor of every
  // company/deal/invoice — portal.manage is what gets them the portal cards,
  // invites and manage mode on its own.
  it('lets portal.manage alone through both preview and manage', () => {
    const productionManager = { permissions: ['portal.preview', 'portal.manage', 'production.access'] };
    expect(allows(productionManager, false)).toBe(true);
    expect(allows(productionManager, true)).toBe(true);
    expect(hasPermission(productionManager, 'deals.manage_all')).toBe(false);
  });

  it('keeps roles without portal.preview out entirely', () => {
    expect(allows(copywriter, false)).toBe(false);
    expect(allows(copywriter, true)).toBe(false);
  });

  it('lets an admin wildcard through both', () => {
    expect(allows(admin, false)).toBe(true);
    expect(allows(admin, true)).toBe(true);
  });

  it('every permission it names is a real slug', () => {
    for (const slug of [...PORTAL_ADMIN_PERMS, ...portalPreviewPerms(false)]) {
      expect(isValidPermission(slug)).toBe(true);
    }
  });
});

describe('permissionsInclude', () => {
  it('handles raw array form', () => {
    expect(permissionsInclude(['*'], 'anything.at_all')).toBe(true);
    expect(permissionsInclude(['users.manage'], 'users.manage')).toBe(true);
    expect(permissionsInclude(['users.manage'], 'roles.manage')).toBe(false);
    expect(permissionsInclude([], 'x')).toBe(false);
    expect(permissionsInclude(null, 'x')).toBe(false);
  });
});
