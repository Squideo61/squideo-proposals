// SPA-side notification catalog. Re-exports the api/_lib/notificationsCatalog
// (the pure-data file with no DB imports) so the admin section can render
// labels + descriptions without duplicating the list.
export { NOTIFICATIONS, isValidNotificationKey, getNotificationMeta } from '../../api/_lib/notificationsCatalog.js';
