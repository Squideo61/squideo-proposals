// The exact marketing-consent wording shown on the course signup form.
//
// Kept as a versioned constant, sent with the signup request, and stored
// verbatim in course_signups.consent_text. Under UK PECR the thing that matters
// is being able to show what someone actually agreed to, on the day they agreed
// to it — so the audit record has to be the rendered wording, not a description
// of it written months later.
//
// CHANGING THIS: bump the version and add a new constant rather than editing
// the old one. Existing rows keep pointing at what those people really saw.

export const MARKETING_CONSENT_VERSION = 'v1';

export const MARKETING_CONSENT_TEXT =
  'Email me practical video tips and the occasional Squideo offer. Unsubscribe any time.';

// Stored alongside the tick so the record is self-describing.
export const consentRecord = (ticked) =>
  `[${MARKETING_CONSENT_VERSION}] ${ticked ? 'ACCEPTED' : 'DECLINED'}: ${MARKETING_CONSENT_TEXT}`;

// The course emails themselves don't depend on the tick — someone who asks for
// a course has asked for the course, and the follow-ups that help them finish
// it are the service they requested (legitimate interest). The tick governs the
// wider marketing: offers, case studies, anything selling rather than teaching.
export const COURSE_EMAILS_NOTICE =
  "We'll email you about the course itself either way — you can stop that from any email.";
