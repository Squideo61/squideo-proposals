import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
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

describe('permissionsInclude', () => {
  it('handles raw array form', () => {
    expect(permissionsInclude(['*'], 'anything.at_all')).toBe(true);
    expect(permissionsInclude(['users.manage'], 'users.manage')).toBe(true);
    expect(permissionsInclude(['users.manage'], 'roles.manage')).toBe(false);
    expect(permissionsInclude([], 'x')).toBe(false);
    expect(permissionsInclude(null, 'x')).toBe(false);
  });
});
