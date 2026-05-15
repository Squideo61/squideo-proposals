// Re-export the API catalog so the SPA can import without crossing the
// src/ ↔ api/ folder boundary in every component. Vite resolves the relative
// path during build; api/_lib/permissions.js has no node-only imports.
export { PERMISSIONS, hasPermission, permissionsInclude, isValidPermission } from '../../api/_lib/permissions.js';
