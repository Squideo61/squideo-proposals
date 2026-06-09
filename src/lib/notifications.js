// SPA-side notification catalog. Re-exports the api/_lib/notificationsCatalog
// (the pure-data file with no DB imports) so the admin section can render
// labels + descriptions without duplicating the list.
export {
  NOTIFICATIONS,
  isValidNotificationKey,
  getNotificationMeta,
  NOTIFICATION_CHANNELS,
  channelForKey,
  FINANCE_CHANNEL_KEYS,
} from '../../api/_lib/notificationsCatalog.js';
