// "Submit to client for review" opens a real, editable email — the same idea as
// the portal invite. A storyboard round and a cut of the film ask the client
// for different things, so there are two saved templates (seeded server-side in
// api/_lib/crm/templates.js) rather than one generic one.
//
// The template can't know the review link, the video's title or which round
// this is, so those come in as placeholders.

import { fillTemplate, unfillTemplate, firstNameFor } from './emailTemplate.js';

export const REVIEW_TEMPLATE_ID = {
  video: 'tpl_review_video',
  storyboard: 'tpl_review_storyboard',
};

// Only used if the seeded template has been deleted — the good copy lives in
// the template, which is the editable one.
const FALLBACK = {
  video: {
    subject: '{{video_title}} — ready for you to review',
    bodyHtml: `<p>Hi {{first_name}},</p>
<p>The latest cut of <strong>{{video_title}}</strong> is ready for you to watch.</p>
<p><a href="{{review_link}}">Watch it and leave your feedback here</a></p>`,
  },
  storyboard: {
    subject: '{{video_title}} — your storyboard is ready to review',
    bodyHtml: `<p>Hi {{first_name}},</p>
<p>The storyboard for <strong>{{video_title}}</strong> is ready for you to look over.</p>
<p><a href="{{review_link}}">View the storyboard and leave your feedback here</a></p>`,
  },
};

export function reviewTemplate(templates, kind) {
  const k = kind === 'storyboard' ? 'storyboard' : 'video';
  const t = (templates || []).find((x) => x.id === REVIEW_TEMPLATE_ID[k]);
  if (!t) return FALLBACK[k];
  return {
    subject: t.subject || FALLBACK[k].subject,
    bodyHtml: t.bodyHtml || FALLBACK[k].bodyHtml,
  };
}

export function fillReview(template, vars) {
  return fillTemplate(template, {
    review_link: vars.reviewUrl || '',
    first_name: firstNameFor(vars),
    name: vars.name || vars.email || '',
    email: vars.email || '',
    company: vars.companyName || 'your organisation',
    video_title: vars.title || 'your video',
    project_title: vars.projectTitle || vars.title || 'your project',
    version: vars.version != null ? 'v' + vars.version : '',
    sender: vars.senderName || 'The Squideo team',
  });
}

// Turn an edited draft back into a template. The review link matters most here:
// it's specific to one project, so saving it would send every future client to
// somebody else's video.
export function unfillReview(html, vars) {
  return unfillTemplate(html, [
    [vars.reviewUrl, 'review_link'],
    [vars.email, 'email'],
    [vars.projectTitle, 'project_title'],
    [vars.companyName, 'company'],
    [vars.title, 'video_title'],
    [firstNameFor(vars), 'first_name'],
  ]);
}
