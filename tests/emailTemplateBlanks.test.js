import { describe, it, expect } from 'vitest';
import { fillTemplate, tidyGreeting, findUnfilledPlaceholders } from '../src/lib/emailTemplate.js';

// A saved script template went out to a client reading "Hi [name], ... the maximum
// word count is # words" because the CRM composer pasted templates in raw and
// nothing checked the blanks before sending. Two halves to that: fill the
// placeholders we can, and refuse to do it silently when a name is missing.

const fill = (html, map) => tidyGreeting(fillTemplate({ subject: '', bodyHtml: html }, map).bodyHtml);

describe('tidyGreeting', () => {
  it('leaves a greeting that got a name alone', () => {
    expect(fill('<p>Hi {{first_name}},</p>', { first_name: 'Laura' }))
      .toBe('<p>Hi Laura,</p>');
  });

  it('drops the name and its comma when nothing is stored for the contact', () => {
    expect(fill('<p>Hi {{first_name}},</p>', { first_name: '' }))
      .toBe('<p>Hi</p>');
  });

  it('clears the empty tag a bold name leaves behind', () => {
    expect(fill('<p>Hi <strong>{{first_name}}</strong>,</p>', { first_name: '' }))
      .toBe('<p>Hi</p>');
  });

  it('keeps a bold name that did resolve', () => {
    expect(fill('<p>Hi <strong>{{first_name}}</strong>,</p>', { first_name: 'Laura' }))
      .toBe('<p>Hi <strong>Laura</strong>,</p>');
  });

  it('handles the other greetings and a non-breaking space', () => {
    expect(fill('<p>Dear&nbsp;{{first_name}}!</p>', { first_name: '' })).toBe('<p>Dear</p>');
    expect(fill('<p>Hello {{first_name}},</p>', { first_name: '' })).toBe('<p>Hello</p>');
  });

  it('does not touch a "Hi" that is part of a sentence', () => {
    expect(tidyGreeting('<p>We said Hi to the team, then left.</p>'))
      .toBe('<p>We said Hi to the team, then left.</p>');
  });
});

describe('findUnfilledPlaceholders', () => {
  it('finds the markers from the email that went out', () => {
    const text = 'Hi [name], the maximum word count is # words.';
    expect(findUnfilledPlaceholders(text).sort()).toEqual(['#', '[name]']);
  });

  it('finds our own placeholder syntax', () => {
    expect(findUnfilledPlaceholders('Hi {{first_name}}, about {{ project_title }}.'))
      .toEqual(['{{first_name}}', '{{ project_title }}']);
  });

  it('passes a fully filled email', () => {
    expect(findUnfilledPlaceholders('Hi Laura, the maximum is 140 words.')).toEqual([]);
  });

  it('does not flag a hash that is part of a word', () => {
    expect(findUnfilledPlaceholders('Studio #4 on the #squideo channel, brand #2BB8E6.')).toEqual([]);
  });

  it('reports each distinct marker once', () => {
    expect(findUnfilledPlaceholders('Hi [name], thanks [name].')).toEqual(['[name]']);
  });
});
