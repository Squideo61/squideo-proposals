// Minimal Google Calendar helper for the Intro Call booking feature, mirroring
// the raw-fetch style of googleDrive.js. All calls take a user's OAuth access
// token (from getFreshAccessToken). Two operations:
//   - freeBusy:  read a user's busy intervals (their own primary calendar)
//   - createEventWithMeet: create a calendar event with a Google Meet link
//
// Calendar scopes (calendar.events + calendar.freebusy) are requested on connect
// via googleScopes(); a 403 here means the connected account predates those
// scopes and must reconnect — surfaced as err.code = 'REAUTH_CALENDAR'.

const CAL_API = 'https://www.googleapis.com/calendar/v3';

async function calFetch(accessToken, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Calendar API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    // 403 insufficientPermissions / insufficient scope → the token is valid for
    // Gmail but lacks Calendar. Distinguish so callers can prompt a reconnect
    // rather than treating it as a transient failure.
    if (res.status === 403 && /insufficient|scope|permission/i.test(body)) {
      err.code = 'REAUTH_CALENDAR';
    }
    throw err;
  }
  return res;
}

// Busy intervals for the token-owner's primary calendar between two instants.
// Returns [{ start: Date, end: Date }] sorted ascending. timeMin/timeMax are
// Date objects (or ISO strings).
export async function freeBusy(accessToken, { timeMin, timeMax }) {
  const body = {
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    timeZone: 'Europe/London',
    items: [{ id: 'primary' }],
  };
  const json = await calFetch(accessToken, `${CAL_API}/freeBusy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const cal = json.calendars && json.calendars.primary;
  const busy = (cal && Array.isArray(cal.busy)) ? cal.busy : [];
  return busy
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .filter((b) => !isNaN(b.start) && !isNaN(b.end))
    .sort((a, b) => a.start - b.start);
}

// Create an event with a Google Meet conference on the token-owner's primary
// calendar. `start`/`end` are Date objects; attendees is an array of email
// strings (the client + the rest of the team). `requestId` must be unique per
// event (we pass the booking id) — Google ties the Meet conference to it.
//
// conferenceDataVersion=1 is mandatory or Meet isn't provisioned. sendUpdates=all
// makes Google email the invite to the client and the team.
// Returns { eventId, meetUrl, htmlLink }.
export async function createEventWithMeet(accessToken, {
  summary,
  description,
  start,
  end,
  attendees = [],
  requestId,
  timeZone = 'Europe/London',
}) {
  const body = {
    summary,
    description,
    start: { dateTime: new Date(start).toISOString(), timeZone },
    end: { dateTime: new Date(end).toISOString(), timeZone },
    attendees: attendees.filter(Boolean).map((email) => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: String(requestId),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: { useDefault: true },
  };
  const url = `${CAL_API}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`;
  const json = await calFetch(accessToken, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  let meetUrl = json.hangoutLink || null;
  if (!meetUrl && json.conferenceData && Array.isArray(json.conferenceData.entryPoints)) {
    const video = json.conferenceData.entryPoints.find((e) => e.entryPointType === 'video');
    meetUrl = video ? video.uri : null;
  }
  return { eventId: json.id, meetUrl, htmlLink: json.htmlLink || null };
}

// Best-effort delete of a booked event (used when a booking is cancelled).
export async function deleteEvent(accessToken, eventId) {
  if (!eventId) return;
  try {
    await calFetch(
      accessToken,
      `${CAL_API}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE' },
    );
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}
