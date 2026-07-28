// Pure serialiser for portal notification rows — kept DB-free (no db.js import)
// so it's unit-testable in isolation. Row → allowlisted camelCase API shape;
// no SELECT * passthrough leaking internal columns (portal_user_id, company_id).

export function serialisePortalNotification(row) {
  return {
    id: row.id,
    key: row.notification_key,
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
