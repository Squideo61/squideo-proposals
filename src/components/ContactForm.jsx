import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COUNTRIES,
  formatPhoneNumber,
  isValidEmail,
  suggestEmailFix,
  getFirstName,
  fireConfetti,
  timeBasedGreeting,
} from './QuoteRequestForm.jsx';
import './QuoteRequestForm.css';
import './ContactForm.css';

// The contact form is a lighter sibling of the multi-step QuoteRequestForm: a
// single screen that captures a message and feeds it into the CRM as a lead via
// the same /api/quote-requests endpoint (the message maps to "project details").
// It reuses the quote widget's styling (the `quote-request-widget` wrapper) plus
// a few contact-specific tweaks in ContactForm.css.

const DEFAULTS = {
  title: 'Got an enquiry?',
  description: 'Fill in the form and a member of our team will get back to you as soon as possible.',
  privacyMessage: 'Your details are private and only used to reply to your enquiry.',
  nameLabel: 'Your name',
  namePlaceholder: 'Jane Smith',
  emailLabel: 'Email address',
  emailPlaceholder: 'you@company.com',
  phoneLabel: 'Phone number',
  phonePlaceholder: 'Phone number',
  messageLabel: 'Your message',
  messagePlaceholder: 'How can we help?',
  optInText: 'Join our mailing list for occasional tips and case studies (no spam, promise).',
  showOptIn: true,
  captchaText: "I'm not a robot",
  captchaLogoText: 'Verify',
  submitButtonText: 'Send message',
  successTitle: 'Message sent!',
  successDescription: "Thanks for getting in touch — a member of the team will get back to you within 48 hours.",
  apiBase: '/api/quote-requests',
  successRedirectUrl: 'https://www.squideo.com/contact-thank-you',
  // Right-hand contact details panel (mirrors the squideo.com/contact page).
  showInfo: true,
  hoursTitle: 'Business Hours',
  hours: [
    ['Mon – Thu', '9:00 am – 5:00 pm'],
    ['Friday', '9:00 am – 4:00 pm'],
    ['Sat – Sun', 'Closed'],
  ],
  infoTitle: 'Contact us!',
  email: 'enquiries@squideo.co.uk',
  phoneDisplay: '(+44) 1482 738656',
  phoneHref: '+441482738656',
  companyName: 'Squideo Ltd',
  address: [
    '2 Exeter Street',
    'New Village Road',
    'Cottingham',
    'East Riding of Yorkshire',
    'HU16 4LU',
    'United Kingdom',
  ],
  nameRequired: true,
  emailRequired: true,
  phoneRequired: true,
  messageRequired: true,
};

const emptyForm = () => ({
  name: '', email: '', phone: '', message: '',
  optIn: false, captchaVerified: false,
});

export function ContactForm(props = {}) {
  const cfg = { ...DEFAULTS, ...props };

  const [form, setForm] = useState(emptyForm);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [emailSuggestion, setEmailSuggestion] = useState(null);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submittedRef = useRef(false);
  const sessionIdRef = useRef(null);
  const countrySelectorRef = useRef(null);
  const countrySearchRef = useRef(null);

  useEffect(() => {
    sessionIdRef.current = 'contact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }, []);

  const userName = useMemo(() => getFirstName(form.name), [form.name]);

  const setField = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);

  const clearError = (field) => setErrors((e) => {
    if (!e[field]) return e;
    const next = { ...e };
    delete next[field];
    return next;
  });

  // ===== Country dropdown =====
  useEffect(() => {
    function onDoc(e) {
      if (countrySelectorRef.current && !countrySelectorRef.current.contains(e.target)) {
        setCountryOpen(false);
        setCountrySearch('');
      }
    }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  useEffect(() => {
    if (countryOpen && countrySearchRef.current) {
      const t = setTimeout(() => countrySearchRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [countryOpen]);

  const filteredCountries = useMemo(() => {
    const term = countrySearch.trim().toLowerCase();
    if (!term) return COUNTRIES;
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(term) ||
      c.code.toLowerCase().includes(term) ||
      c.dialCode.includes(term)
    );
  }, [countrySearch]);

  const pickCountry = (c) => {
    setCountry(c);
    setCountryOpen(false);
    setCountrySearch('');
    if (form.phone) {
      const digits = form.phone.replace(/\D/g, '');
      setField('phone', formatPhoneNumber(digits, c.format));
    }
  };

  const onPhoneChange = (e) => {
    const digits = e.target.value.replace(/\D/g, '');
    setField('phone', formatPhoneNumber(digits, country.format));
  };

  const onEmailBlur = () => {
    const v = form.email.trim();
    if (v && !isValidEmail(v)) {
      setErrors((e) => ({ ...e, email: 'Please enter a valid email address (e.g., name@example.com)' }));
      setEmailSuggestion(null);
      return;
    }
    if (v) {
      setEmailSuggestion(suggestEmailFix(v));
      clearError('email');
    }
  };

  const validate = () => {
    const newErrors = {};
    if (cfg.nameRequired && !form.name.trim()) newErrors.name = 'Please enter your name so we know who we\'re talking to';
    if (cfg.emailRequired && !form.email.trim()) newErrors.email = 'We need your email so we can reply';
    if (form.email.trim() && !isValidEmail(form.email.trim())) newErrors.email = 'Please enter a valid email address (e.g., name@example.com)';
    if (cfg.phoneRequired && !form.phone.trim()) newErrors.phone = 'A phone number helps us reach you faster';
    if (cfg.messageRequired && !form.message.trim()) newErrors.message = 'Please add a short message so we know how to help';
    if (!form.captchaVerified) newErrors['captcha-verified'] = "⚠️ Please verify that you're not a robot by checking the box above";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submittedRef.current) return;
    if (!validate()) return;

    submittedRef.current = true;
    setSubmitting(true);

    try {
      const payload = {
        formSessionId: sessionIdRef.current,
        // Tells the shared /api/quote-requests endpoint to label the team
        // notifications "New enquiry" instead of "New quote request".
        leadKind: 'contact',
        name: form.name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        countryCode: country?.dialCode || null,
        countryName: country?.name || null,
        // The message becomes the lead's "project details" so it shows up in the
        // new-lead email and the CRM quote-requests list exactly like a quote.
        projectDetails: form.message.trim() || null,
        optIn: !!form.optIn,
        sourceUrl: window.location.href,
        attribution: cfg.getAttribution?.() || null,
      };

      const res = await fetch(cfg.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Submit failed (${res.status})`);

      fireConfetti();
      setTimeout(fireConfetti, 200);
      setDone(true);
      if (typeof cfg.onSubmitted === 'function') {
        try { cfg.onSubmitted(payload); } catch { /* */ }
      }
      if (cfg.successRedirectUrl) {
        // Small delay so the confetti is visible. Use window.top so we break out
        // of the iframe when embedded on squideo.com; falls through to the
        // current window if top isn't reachable.
        setTimeout(() => {
          try { (window.top || window).location.href = cfg.successRedirectUrl; }
          catch { window.location.href = cfg.successRedirectUrl; }
        }, 1200);
      }
    } catch (err) {
      console.error('[ContactForm] submit error', err);
      submittedRef.current = false;
      setErrors((er) => ({
        ...er,
        'captcha-verified': 'Something went wrong sending your message. Please try again, or email us directly.',
      }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`quote-request-widget contact-form-widget ${cfg.showInfo ? 'has-info' : ''}`}>
      <div className="progress-form-container">
        <div className="contact-layout">
          <div className="contact-form-col">
        <form className="multi-step-form" onSubmit={onSubmit} noValidate>
          {done ? (
            <div className="form-step success-message active">
              <div className="success-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="step-title">{userName ? `Thanks ${userName}!` : cfg.successTitle}</h2>
              <p className="step-description">{cfg.successDescription}</p>
            </div>
          ) : (
            <div className="form-step active">
              <h2 className="step-title">{`${timeBasedGreeting()} ${cfg.title}`}</h2>
              <p className="step-description">{cfg.description}</p>

              <div className="privacy-badge">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="privacy-icon">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span>{cfg.privacyMessage}</span>
              </div>

              <div className="form-group">
                <label htmlFor="cf-name">{cfg.nameLabel}{!cfg.nameRequired && <span className="optional-label"> (optional)</span>}</label>
                <input
                  type="text" id="cf-name" name="name"
                  className={`form-input ${errors.name ? 'error' : ''}`}
                  placeholder={cfg.namePlaceholder}
                  value={form.name}
                  onChange={(e) => { setField('name', e.target.value); if (errors.name) clearError('name'); }}
                />
                {errors.name && <span className="error-message visible">{errors.name}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="cf-email">{cfg.emailLabel}{!cfg.emailRequired && <span className="optional-label"> (optional)</span>}</label>
                <input
                  type="email" id="cf-email" name="email"
                  className={`form-input ${errors.email ? 'error' : ''}`}
                  placeholder={cfg.emailPlaceholder}
                  value={form.email}
                  onChange={(e) => { setField('email', e.target.value); if (errors.email) clearError('email'); setEmailSuggestion(null); }}
                  onBlur={onEmailBlur}
                />
                {emailSuggestion && (
                  <div className="email-suggestion visible">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="suggestion-icon">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="suggestion-text">
                      Did you mean{' '}
                      <button
                        type="button" className="suggestion-link"
                        onClick={() => { setField('email', emailSuggestion); setEmailSuggestion(null); clearError('email'); }}
                      >
                        {emailSuggestion}
                      </button>?
                    </span>
                  </div>
                )}
                {errors.email && <span className="error-message visible">{errors.email}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="cf-phone">{cfg.phoneLabel}{!cfg.phoneRequired && <span className="optional-label"> (optional)</span>}</label>
                <div className="phone-input-wrapper">
                  <div className="country-selector" ref={countrySelectorRef}>
                    <button type="button" className="country-selector-btn" onClick={() => setCountryOpen((o) => !o)}>
                      <span className="selected-code">{country.code} {country.dialCode}</span>
                      <svg className="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>
                    {countryOpen && (
                      <div className="country-dropdown open" style={{ display: 'block' }}>
                        <div className="country-search-wrapper">
                          <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                          </svg>
                          <input
                            ref={countrySearchRef} type="text" className="country-search"
                            placeholder="Search country..." autoComplete="off"
                            value={countrySearch}
                            onChange={(e) => setCountrySearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') { setCountryOpen(false); setCountrySearch(''); } }}
                          />
                        </div>
                        <div className="country-list">
                          {filteredCountries.map(c => (
                            <div key={c.code} className="country-option" onClick={() => pickCountry(c)}>
                              <span className="country-code">{c.code}</span>
                              <span className="country-dial-code">{c.dialCode}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <input
                    type="tel" id="cf-phone" name="phone"
                    className={`form-input phone-number-input ${errors.phone ? 'error' : ''}`}
                    placeholder={cfg.phonePlaceholder}
                    value={form.phone}
                    onChange={onPhoneChange}
                  />
                </div>
                {errors.phone && <span className="error-message visible">{errors.phone}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="cf-message">{cfg.messageLabel}{!cfg.messageRequired && <span className="optional-label"> (optional)</span>}</label>
                <textarea
                  id="cf-message" name="message" rows={4}
                  className={`form-input contact-message-large ${errors.message ? 'error' : ''}`}
                  placeholder={cfg.messagePlaceholder}
                  value={form.message}
                  onChange={(e) => { setField('message', e.target.value); if (errors.message) clearError('message'); }}
                />
                {errors.message && <span className="error-message visible">{errors.message}</span>}
              </div>

              {cfg.showOptIn && (
                <div className="form-group">
                  <div className="checkbox-wrapper">
                    <input
                      type="checkbox" id="cf-optin" name="opt-in"
                      className="checkbox-input"
                      checked={form.optIn}
                      onChange={(e) => setField('optIn', e.target.checked)}
                    />
                    <label htmlFor="cf-optin" className="checkbox-label">{cfg.optInText}</label>
                  </div>
                </div>
              )}

              <div className="form-group">
                <div className="captcha-container">
                  <div className="captcha-box">
                    <div className="captcha-checkbox-wrapper">
                      <input
                        type="checkbox" id="cf-captcha" name="captcha-verified"
                        className="captcha-checkbox"
                        checked={form.captchaVerified}
                        onChange={(e) => { setField('captchaVerified', e.target.checked); if (errors['captcha-verified']) clearError('captcha-verified'); }}
                      />
                      <label htmlFor="cf-captcha" className="captcha-label">
                        <span className="captcha-checkmark" />
                      </label>
                    </div>
                    <div className="captcha-text">
                      <span className="captcha-main-text">{cfg.captchaText}</span>
                      <div className="captcha-logo">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="captcha-icon">
                          <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                        <span className="captcha-logo-text">{cfg.captchaLogoText}</span>
                      </div>
                    </div>
                  </div>
                  {errors['captcha-verified'] && <span className="error-message visible">{errors['captcha-verified']}</span>}
                </div>
              </div>

              <div className="form-navigation">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Sending…' : cfg.submitButtonText}
                </button>
              </div>
            </div>
          )}
        </form>
          </div>

          {cfg.showInfo && (
            <aside className="contact-info-col">
              <div className="contact-info-block">
                <h3 className="contact-info-title">{cfg.hoursTitle}</h3>
                <table className="contact-hours">
                  <tbody>
                    {cfg.hours.map(([days, time]) => (
                      <tr key={days}>
                        <td className="contact-hours-days">{days}</td>
                        <td className="contact-hours-time">{time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="contact-info-block">
                <h3 className="contact-info-title">{cfg.infoTitle}</h3>
                {cfg.email && (
                  <p className="contact-info-line">
                    <a href={`mailto:${cfg.email}`} className="contact-info-link">{cfg.email}</a>
                  </p>
                )}
                {cfg.phoneDisplay && (
                  <p className="contact-info-line">
                    Call us:{' '}
                    <a href={`tel:${cfg.phoneHref || cfg.phoneDisplay}`} className="contact-info-link">{cfg.phoneDisplay}</a>
                  </p>
                )}
              </div>

              {(cfg.companyName || (cfg.address && cfg.address.length > 0)) && (
                <address className="contact-info-block contact-address">
                  {cfg.companyName && <span className="contact-company">{cfg.companyName}</span>}
                  {(cfg.address || []).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </address>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContactForm;
