// The review email is composed by hand from a template, and the one value that
// MUST survive is the review link — a mangled {{review_link}} sends the client
// to nothing, and a link left behind when the draft is saved as the template
// sends every future client to somebody else's video.
import { describe, it, expect } from 'vitest';
import {
  reviewTemplate, fillReview, unfillReview, REVIEW_TEMPLATE_ID,
} from '../src/lib/reviewEmail.js';
import { wrapSignature } from '../src/lib/emailTemplate.js';

const LINK = 'https://app.squideo.com/?revision=8f2c1e5a-77b0-4d3e-9a1c-6b2f0d4e8a91';

describe('reviewTemplate', () => {
  it('picks the template matching the kind', () => {
    const templates = [
      { id: REVIEW_TEMPLATE_ID.video, subject: 'Video subject', bodyHtml: '<p>Video</p>' },
      { id: REVIEW_TEMPLATE_ID.storyboard, subject: 'Storyboard subject', bodyHtml: '<p>Storyboard</p>' },
    ];
    expect(reviewTemplate(templates, 'video').subject).toBe('Video subject');
    expect(reviewTemplate(templates, 'storyboard').subject).toBe('Storyboard subject');
  });

  it('falls back when the saved template has been deleted', () => {
    expect(reviewTemplate([], 'video').bodyHtml).toContain('{{review_link}}');
    expect(reviewTemplate(null, 'storyboard').bodyHtml).toContain('{{review_link}}');
  });

  it('treats anything that is not a storyboard as a video', () => {
    const templates = [{ id: REVIEW_TEMPLATE_ID.video, subject: 'Video subject', bodyHtml: '<p>v</p>' }];
    expect(reviewTemplate(templates, undefined).subject).toBe('Video subject');
  });
});

describe('fillReview', () => {
  const tpl = {
    subject: '{{video_title}} — ready to review',
    bodyHtml: '<p>Hi {{first_name}},</p><p><a href="{{review_link}}">Watch it</a> for {{company}}</p>',
  };
  const vars = {
    reviewUrl: LINK, email: 'dan.clark@kingspan.com', name: 'Dan Clark',
    companyName: 'Kingspan Ltd', title: 'Brand Film', projectTitle: 'Kingspan — Brand Film', version: 2,
  };

  it('puts the review link into the href intact', () => {
    expect(fillReview(tpl, vars).bodyHtml).toContain(`href="${LINK}"`);
  });

  it('names the video in the subject, unescaped — it is plain text', () => {
    const out = fillReview(tpl, { ...vars, title: 'Health & Safety' });
    expect(out.subject).toBe('Health & Safety — ready to review');
  });

  it('greets by first name and falls back to the address', () => {
    expect(fillReview(tpl, vars).bodyHtml).toContain('Hi Dan,');
    expect(fillReview(tpl, { ...vars, name: null }).bodyHtml).toContain('Hi Dan,');
  });

  it('escapes values in the body so a title cannot break the markup', () => {
    const out = fillReview({ subject: 'x', bodyHtml: '<p>{{video_title}}</p>' },
      { ...vars, title: '<script>alert(1)</script>' });
    expect(out.bodyHtml).not.toContain('<script>');
    expect(out.bodyHtml).toContain('&lt;script&gt;');
  });

  it('renders the round as v2, and blanks it when there is no draft number', () => {
    const t = { subject: 's', bodyHtml: '<p>{{version}}</p>' };
    expect(fillReview(t, vars).bodyHtml).toContain('v2');
    expect(fillReview(t, { ...vars, version: null }).bodyHtml).toBe('<p></p>');
  });

  it('never renders a bare "your video" gap when the title is missing', () => {
    const out = fillReview(tpl, { ...vars, title: null });
    expect(out.subject).toBe('your video — ready to review');
  });
});

// Saving an edited draft as the template must not bake in the project it was
// written for — least of all its review link.
describe('unfillReview', () => {
  const vars = {
    reviewUrl: LINK, email: 'dan.clark@kingspan.com', name: 'Dan Clark',
    companyName: 'Kingspan Ltd', title: 'Brand Film', projectTitle: 'Kingspan — Brand Film',
  };

  it('puts the review link back as a placeholder', () => {
    const out = unfillReview(`<p><a href="${LINK}">Watch it</a></p>`, vars);
    expect(out).not.toContain(LINK);
    expect(out).toContain('{{review_link}}');
  });

  it('puts the video title back as a placeholder', () => {
    expect(unfillReview('<p>The latest cut of Brand Film</p>', vars)).toContain('{{video_title}}');
  });

  it('matches the project title before the video title it contains', () => {
    const out = unfillReview('<p>on Kingspan — Brand Film</p>', vars);
    expect(out).toContain('{{project_title}}');
    expect(out).not.toContain('{{video_title}}');
  });

  it('drops the signature', () => {
    const body = `<p>Hi Dan,</p><br>${wrapSignature('<div>Callum Major<br>Production Manager</div>')}`;
    const out = unfillReview(body, vars);
    expect(out).not.toContain('Production Manager');
    expect(out).toContain('{{first_name}}');
  });

  it('round-trips: fill then unfill returns the template', () => {
    const tpl = { subject: 's', bodyHtml: '<p>Hi {{first_name}},</p><p><a href="{{review_link}}">Watch {{video_title}}</a></p>' };
    const filled = fillReview(tpl, vars);
    expect(unfillReview(filled.bodyHtml, vars)).toBe(tpl.bodyHtml);
  });

  it('leaves a body with nothing to substitute alone', () => {
    expect(unfillReview('<p>Nothing project-specific here.</p>', vars)).toBe('<p>Nothing project-specific here.</p>');
  });
});
