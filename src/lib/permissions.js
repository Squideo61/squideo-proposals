// Re-export the API catalog so the SPA can import without crossing the
// src/ ↔ api/ folder boundary in every component. Vite resolves the relative
// path during build; api/_lib/permissions.js has no node-only imports.
export { PERMISSIONS, hasPermission, permissionsInclude, isValidPermission } from '../../api/_lib/permissions.js';
// The portal card reads at portal.preview but writes at portal-admin level, so
// the SPA needs the same list the server gates writes with — hiding controls a
// click would only 403 on.
export { PORTAL_ADMIN_PERMS } from '../../api/_lib/permissions.js';
