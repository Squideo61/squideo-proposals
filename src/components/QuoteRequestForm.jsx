import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import './QuoteRequestForm.css';

const TOTAL_STEPS = 4;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 5;
const STORAGE_PREFIX = 'progressForm_';
const STEP_TIMES = { 1: 2, 2: 1.5, 3: 1, 4: 0.5 };
const STEP_LABELS = ['Contact', 'Project', 'Timeline', 'Finish'];

const COMMON_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
];

const COUNTRIES = [
  { name: 'United Kingdom', code: 'GB', dialCode: '+44', format: '##### ### ###' },
  { name: 'United States', code: 'US', dialCode: '+1', format: '(###) ###-####' },
  { name: 'Canada', code: 'CA', dialCode: '+1', format: '(###) ###-####' },
  { name: 'Australia', code: 'AU', dialCode: '+61', format: '#### ### ###' },
  { name: 'Germany', code: 'DE', dialCode: '+49', format: '### ########' },
  { name: 'France', code: 'FR', dialCode: '+33', format: '# ## ## ## ##' },
  { name: 'Italy', code: 'IT', dialCode: '+39', format: '### ### ####' },
  { name: 'Spain', code: 'ES', dialCode: '+34', format: '### ### ###' },
  { name: 'Netherlands', code: 'NL', dialCode: '+31', format: '## ########' },
  { name: 'Belgium', code: 'BE', dialCode: '+32', format: '### ## ## ##' },
  { name: 'Switzerland', code: 'CH', dialCode: '+41', format: '## ### ## ##' },
  { name: 'Austria', code: 'AT', dialCode: '+43', format: '### #######' },
  { name: 'Sweden', code: 'SE', dialCode: '+46', format: '##-### ## ##' },
  { name: 'Norway', code: 'NO', dialCode: '+47', format: '### ## ###' },
  { name: 'Denmark', code: 'DK', dialCode: '+45', format: '## ## ## ##' },
  { name: 'Finland', code: 'FI', dialCode: '+358', format: '## ### ####' },
  { name: 'Poland', code: 'PL', dialCode: '+48', format: '### ### ###' },
  { name: 'Ireland', code: 'IE', dialCode: '+353', format: '## ### ####' },
  { name: 'Portugal', code: 'PT', dialCode: '+351', format: '### ### ###' },
  { name: 'Greece', code: 'GR', dialCode: '+30', format: '### ### ####' },
  { name: 'Czech Republic', code: 'CZ', dialCode: '+420', format: '### ### ###' },
  { name: 'Romania', code: 'RO', dialCode: '+40', format: '### ### ###' },
  { name: 'Hungary', code: 'HU', dialCode: '+36', format: '## ### ####' },
  { name: 'New Zealand', code: 'NZ', dialCode: '+64', format: '## ### ####' },
  { name: 'Singapore', code: 'SG', dialCode: '+65', format: '#### ####' },
  { name: 'Japan', code: 'JP', dialCode: '+81', format: '##-####-####' },
  { name: 'South Korea', code: 'KR', dialCode: '+82', format: '##-####-####' },
  { name: 'China', code: 'CN', dialCode: '+86', format: '### #### ####' },
  { name: 'India', code: 'IN', dialCode: '+91', format: '##### #####' },
  { name: 'Brazil', code: 'BR', dialCode: '+55', format: '## #####-####' },
  { name: 'Mexico', code: 'MX', dialCode: '+52', format: '## #### ####' },
  { name: 'Argentina', code: 'AR', dialCode: '+54', format: '## ####-####' },
  { name: 'Chile', code: 'CL', dialCode: '+56', format: '# #### ####' },
  { name: 'South Africa', code: 'ZA', dialCode: '+27', format: '## ### ####' },
  { name: 'Israel', code: 'IL', dialCode: '+972', format: '##-###-####' },
  { name: 'United Arab Emirates', code: 'AE', dialCode: '+971', format: '## ### ####' },
  { name: 'Saudi Arabia', code: 'SA', dialCode: '+966', format: '## ### ####' },
  { name: 'Turkey', code: 'TR', dialCode: '+90', format: '### ### ####' },
  { name: 'Russia', code: 'RU', dialCode: '+7', format: '### ###-##-##' },
  { name: 'Ukraine', code: 'UA', dialCode: '+380', format: '## ### ####' },
  { name: 'Thailand', code: 'TH', dialCode: '+66', format: '## ### ####' },
  { name: 'Malaysia', code: 'MY', dialCode: '+60', format: '##-### ####' },
  { name: 'Indonesia', code: 'ID', dialCode: '+62', format: '###-###-####' },
  { name: 'Philippines', code: 'PH', dialCode: '+63', format: '#### ### ####' },
  { name: 'Vietnam', code: 'VN', dialCode: '+84', format: '### ### ####' },
  { name: 'Egypt', code: 'EG', dialCode: '+20', format: '### ### ####' },
  { name: 'Nigeria', code: 'NG', dialCode: '+234', format: '### ### ####' },
  { name: 'Kenya', code: 'KE', dialCode: '+254', format: '### ### ###' },
];

const DEFAULTS = {
  estimatedTime: '3 minutes',
  step1Title: "Let's get to know you",
  step1Description: 'Quick details so we know how to reach you.',
  step2Title: 'Tell us about your project',
  step2Description: "Help us understand what you're looking for",
  step3Title: "Timeline and budget",
  step3Description: 'This helps us provide you with the best options',
  step4Title: 'Almost done!',
  step4Description: 'Anything else we should know?',
  successTitle: 'Thank you!',
  successDescription: "We've received your quote request and will be in touch within 1 business day.",
  privacyMessage: 'Your details are private and only used to prepare your quote.',
  nameLabel: 'Full name',
  namePlaceholder: 'Jane Smith',
  emailLabel: 'Email address',
  emailPlaceholder: 'you@company.com',
  phoneLabel: 'Phone number',
  phonePlaceholder: 'Phone number',
  companyLabel: 'Company or Organisation',
  companyPlaceholder: 'Your company or organisation name',
  projectDetailsLabel: 'Project details',
  projectDetailsPlaceholder: 'Just one video, or more? A short description is just fine at this stage. If you have a brief or script already you can upload one in the next step.',
  caveatIntro: "To quote accurately, we'll need to know:",
  caveatPoint1: "• How many videos you're looking for",
  caveatPoint2: '• How long each of the videos need to be (roughly)',
  caveatPoint3: '• Any references, style ideas, or examples you like',
  caveatNote: '*The more content we are quoting for, the better the rate we can offer.',
  timelineLabel: 'When do you need this?',
  timelinePlaceholder: 'Select a timeline',
  timelineCaveat: '*Please note - Turnaround times for video projects requiring more than 5 minutes of content will need to be assessed on a case-by-case basis. We will take your answer below into consideration.',
  timelineOptions: [
    "~4 weeks - It's a priority",
    "6-8 weeks - I'm happy to slot into Squideo's normal production schedule",
    "I'm not ready yet, but I'm open to booking in early for a discount on my quote",
  ],
  budgetLabel: 'What budget is going to work for you?',
  budgetPlaceholder: "This ensures we provide useful options and keeps things efficient on both sides. If you're unsure, a rough guess is still really helpful.",
  fileUploadLabel: 'Upload a brief, or script if you have one',
  fileUploadButtonText: 'Click to upload or drag files here',
  optInText: 'Send me occasional tips and case studies from Squideo.',
  showOptIn: true,
  captchaText: "I'm not a robot",
  captchaLogoText: 'Verify',
  exitIntentTitle: "Wait! Don't leave yet",
  exitIntentDescription: "You're almost there. We'll email you a link to your saved quote and a few friendly reminders if you don't get back to it.",
  exitIntentContinueButton: 'Continue my quote',
  exitIntentSaveButton: 'Save & email me a link',
  prevButtonText: 'Back',
  nextButtonText: "Yes, Let's Continue! →",
  submitButtonText: '🎉 Get My Free Quote!',
  enableExitIntent: true,
  exitIntentDelayMs: 3000,
  nameRequired: true,
  emailRequired: true,
  phoneRequired: true,
  companyRequired: true,
  projectDetailsRequired: true,
  timelineRequired: true,
  budgetRequired: true,
  apiBase: '/api/quote-requests',
};

function formatPhoneNumber(value, format) {
  if (!format) return value;
  const digits = (value || '').replace(/\D/g, '');
  let out = '';
  let di = 0;
  for (let i = 0; i < format.length && di < digits.length; i++) {
    if (format[i] === '#') { out += digits[di]; di++; }
    else out += format[i];
  }
  out += digits.substring(di);
  return out;
}

function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i - 1] === a[j - 1]
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

function suggestEmailFix(email) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (!domain) return null;
  const d = domain.toLowerCase();
  for (const correct of COMMON_DOMAINS) {
    const dist = levenshtein(d, correct);
    if (dist > 0 && dist <= 2 && d !== correct) return `${local}@${correct}`;
  }
  return null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function timeBasedGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning!';
  if (h >= 12 && h < 17) return 'Good afternoon!';
  if (h >= 17 && h < 21) return 'Good evening!';
  return 'Working late?';
}

function getFirstName(full) {
  if (!full) return '';
  const cleaned = full.replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+/i, '').trim();
  const first = cleaned.split(/\s+/)[0] || '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function formatFileSize(bytes) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function fireConfetti() {
  try {
    const colors = ['#7ac943', '#6bb635', '#FFD700', '#FFA500', '#4ECDC4', '#FF6B6B'];
    const defaults = {
      zIndex: 2147483647,
      disableForReducedMotion: false,
      colors,
      startVelocity: 45,
      gravity: 0.9,
      ticks: 200,
    };
    confetti({ ...defaults, particleCount: 60, spread: 60, angle: 60, origin: { x: 0, y: 0.7 } });
    confetti({ ...defaults, particleCount: 60, spread: 60, angle: 120, origin: { x: 1, y: 0.7 } });
    confetti({ ...defaults, particleCount: 100, spread: 90, origin: { x: 0.5, y: 0.6 } });
  } catch { /* canvas-confetti not critical */ }
}

const emptyForm = () => ({
  name: '', email: '', phone: '', company: '',
  projectDetails: '', timeline: '', budget: '',
  optIn: false, captchaVerified: false,
});

export function QuoteRequestForm(props = {}) {
  const cfg = { ...DEFAULTS, ...props };

  const [step, setStep] = useState(1); // 1..4 or 'success'
  const [form, setForm] = useState(emptyForm);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [emailSuggestion, setEmailSuggestion] = useState(null);
  const [errors, setErrors] = useState({});
  const [files, setFiles] = useState([]); // { id, file, uploaded?, blobUrl?, blobPathname? }
  const [submitting, setSubmitting] = useState(false);
  const [pulseNext, setPulseNext] = useState(false);
  const [welcomeBanner, setWelcomeBanner] = useState(null); // { visible, sessionId, title, description }
  const [exitOpen, setExitOpen] = useState(false);
  const [timeBadgeTick, setTimeBadgeTick] = useState(0);

  const sessionIdRef = useRef(null);
  const startTimeRef = useRef(null);
  const submittedRef = useRef(false);
  const exitShownRef = useRef(false);
  const canShowExitRef = useRef(false);
  const lastFieldRef = useRef(null);
  const fileInputRef = useRef(null);
  const countrySelectorRef = useRef(null);
  const countrySearchRef = useRef(null);
  const navRef = useRef(null);
  const initialisedRef = useRef(false);

  const userName = useMemo(() => getFirstName(form.name), [form.name]);

  // Time remaining for badge
  const remainingMinutes = useMemo(() => {
    if (step === 'success') return 0;
    let t = 0;
    for (let i = step; i <= TOTAL_STEPS; i++) t += STEP_TIMES[i] || 0;
    return Math.ceil(t);
  }, [step]);

  const setField = useCallback((k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    lastFieldRef.current = k;
  }, []);

  // ===== localStorage =====
  const saveProgress = useCallback(() => {
    if (!sessionIdRef.current) return;
    const payload = {
      sessionId: sessionIdRef.current,
      currentStep: typeof step === 'number' ? step : 1,
      startTime: startTimeRef.current,
      lastActivity: Date.now(),
      userName,
      lastEditedField: lastFieldRef.current,
      selectedCountry: country,
      data: form,
    };
    try {
      localStorage.setItem(STORAGE_PREFIX + sessionIdRef.current, JSON.stringify(payload));
    } catch { /* quota/private mode */ }
  }, [step, form, country, userName]);

  useEffect(() => {
    if (initialisedRef.current) saveProgress();
  }, [form, step, country, saveProgress]);

  const autosaveTimerRef = useRef(null);
  const autosaveLastRef = useRef('');
  useEffect(() => {
    if (!initialisedRef.current) return;
    if (submittedRef.current) return;
    const projectDetails = form.projectDetails.trim();
    if (!projectDetails) return;
    if (!sessionIdRef.current) return;

    const payload = {
      formSessionId: sessionIdRef.current,
      name: form.name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      countryCode: country?.dialCode || null,
      countryName: country?.name || null,
      company: form.company.trim() || null,
      projectDetails,
      timeline: form.timeline || null,
      budget: form.budget.trim() || null,
      sourceUrl: window.location.href,
      lastStep: typeof step === 'number' ? step : null,
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === autosaveLastRef.current) return;

    const send = () => {
      autosaveLastRef.current = fingerprint;
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([fingerprint], { type: 'application/json' });
          navigator.sendBeacon(`${cfg.apiBase}?action=autosave`, blob);
          return;
        }
      } catch { /* fall through */ }
      fetch(`${cfg.apiBase}?action=autosave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fingerprint,
        keepalive: true,
      }).catch(() => { /* non-critical */ });
    };

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(send, 2500);

    const onUnload = () => { if (autosaveLastRef.current !== fingerprint) send(); };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [form, step, country, cfg.apiBase]);

  const loadSession = useCallback((sessionId) => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + sessionId);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      sessionIdRef.current = saved.sessionId;
      startTimeRef.current = saved.startTime;
      if (saved.selectedCountry) setCountry(saved.selectedCountry);
      if (saved.data) setForm({ ...emptyForm(), ...saved.data });
      lastFieldRef.current = saved.lastEditedField || null;
      const target = Math.min(Math.max(parseInt(saved.currentStep, 10) || 1, 1), TOTAL_STEPS);
      setStep(target);
      return true;
    } catch { return false; }
  }, []);

  const checkReturning = useCallback(() => {
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(STORAGE_PREFIX));
      if (!keys.length) return false;
      const recent = keys
        .map(k => {
          try { return [k, JSON.parse(localStorage.getItem(k))]; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))[0];
      if (!recent) return false;
      const [, saved] = recent;
      const ageDays = (Date.now() - (saved.lastActivity || 0)) / (1000 * 60 * 60 * 24);
      if (ageDays >= 7 || (saved.currentStep || 1) >= TOTAL_STEPS) return false;
      const percent = Math.round((saved.currentStep / TOTAL_STEPS) * 100);
      const greeting = timeBasedGreeting();
      setWelcomeBanner({
        visible: true,
        sessionId: saved.sessionId,
        title: saved.userName ? `${greeting} Welcome back, ${saved.userName}!` : `${greeting} Welcome back!`,
        description: `You have a quote request that's ${percent}% complete (Step ${saved.currentStep} of ${TOTAL_STEPS}).`,
      });
      return true;
    } catch { return false; }
  }, []);

  // ===== Init =====
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;

    const url = new URL(window.location.href);
    const resumeId = url.searchParams.get('resume');
    const stepParam = url.searchParams.get('step');

    let resumed = false;
    if (resumeId) {
      resumed = loadSession(resumeId);
    } else {
      resumed = checkReturning();
    }

    if (!resumed) {
      sessionIdRef.current = 'form_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
      startTimeRef.current = Date.now();
      if (stepParam) {
        const s = parseInt(stepParam, 10);
        if (s >= 1 && s <= TOTAL_STEPS) setStep(s);
      }
    }

    saveProgress();

    const t = setTimeout(() => { canShowExitRef.current = true; }, cfg.exitIntentDelayMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== Step change → URL =====
  useEffect(() => {
    if (!initialisedRef.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', String(step));
    try { window.history.replaceState({ step, formSession: sessionIdRef.current }, '', url); } catch { /* */ }
    setTimeBadgeTick(t => t + 1);
  }, [step]);

  // ===== Country dropdown click-outside =====
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

  // ===== Exit intent =====
  useEffect(() => {
    if (!cfg.enableExitIntent) return;
    function onLeave(e) {
      if (!canShowExitRef.current || exitShownRef.current || submittedRef.current) return;
      if (step === 'success' || step === 1) return;
      if (e.clientY <= 0) {
        exitShownRef.current = true;
        setExitOpen(true);
        saveProgress();
      }
    }
    document.addEventListener('mouseleave', onLeave);
    return () => document.removeEventListener('mouseleave', onLeave);
  }, [cfg.enableExitIntent, step, saveProgress]);

  // ===== Field validation =====
  const clearError = (field) => setErrors((e) => {
    if (!e[field]) return e;
    const next = { ...e };
    delete next[field];
    return next;
  });

  const validateStep = (n) => {
    const newErrors = {};
    if (n === 1) {
      if (cfg.nameRequired && !form.name.trim()) newErrors.name = 'Please enter your name so we can address you properly';
      if (cfg.emailRequired && !form.email.trim()) newErrors.email = 'We need your email to send you the quote';
      if (form.email.trim() && !isValidEmail(form.email.trim())) newErrors.email = 'Please enter a valid email address (e.g., name@example.com)';
      if (cfg.phoneRequired && !form.phone.trim()) newErrors.phone = 'A phone number helps us reach you faster';
      if (cfg.companyRequired && !form.company.trim()) newErrors.company = 'Please enter your company or organisation';
    } else if (n === 2) {
      if (cfg.projectDetailsRequired && !form.projectDetails.trim()) {
        newErrors['project-details'] = 'Please tell us a bit about your project (even a short description helps!)';
      }
    } else if (n === 3) {
      if (cfg.timelineRequired && !form.timeline) newErrors.timeline = 'Please select your preferred timeline';
      if (cfg.budgetRequired && !form.budget.trim()) newErrors.budget = 'Please share a rough budget — even a guess helps';
    } else if (n === 4) {
      if (!form.captchaVerified) newErrors['captcha-verified'] = "⚠️ Please verify that you're not a robot by checking the box above";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // ===== Country pick =====
  const pickCountry = (c) => {
    setCountry(c);
    setCountryOpen(false);
    setCountrySearch('');
    // Reformat existing phone number with new country format
    if (form.phone) {
      const digits = form.phone.replace(/\D/g, '');
      setField('phone', formatPhoneNumber(digits, c.format));
    }
  };

  const onPhoneChange = (e) => {
    const raw = e.target.value;
    const digits = raw.replace(/\D/g, '');
    const formatted = formatPhoneNumber(digits, country.format);
    setField('phone', formatted);
  };

  // ===== Email blur =====
  const onEmailBlur = () => {
    const v = form.email.trim();
    if (v && !isValidEmail(v)) {
      setErrors((e) => ({ ...e, email: 'Please enter a valid email address (e.g., name@example.com)' }));
      setEmailSuggestion(null);
      return;
    }
    if (v) {
      const sug = suggestEmailFix(v);
      setEmailSuggestion(sug);
      clearError('email');
    }
  };

  // ===== Files =====
  const totalFileSize = files.reduce((s, f) => s + (f.file?.size || 0), 0);

  const onFilePick = (e) => {
    clearError('file-upload');
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    if (list.length > MAX_FILES) {
      setErrors((er) => ({ ...er, 'file-upload': `⚠️ Maximum ${MAX_FILES} files allowed. You selected ${list.length} files.` }));
      e.target.value = '';
      return;
    }
    const total = list.reduce((s, f) => s + f.size, 0);
    if (total > MAX_FILE_SIZE) {
      setErrors((er) => ({
        ...er,
        'file-upload': `⚠️ Total file size exceeds 20MB!\n\nYour files: ${formatFileSize(total)}\nMaximum: ${formatFileSize(MAX_FILE_SIZE)}\n\nPlease choose fewer or smaller files.`,
      }));
      e.target.value = '';
      return;
    }
    setFiles(list.map((f, i) => ({ id: `${Date.now()}_${i}`, file: f })));
  };

  const removeFile = (id) => {
    setFiles((f) => f.filter(x => x.id !== id));
    clearError('file-upload');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ===== Navigation =====
  const goNext = () => {
    if (!validateStep(step)) return;
    fireConfetti();
    if (step < TOTAL_STEPS) {
      setStep(step + 1);
      setPulseNext(false);
    }
  };

  const goPrev = () => {
    if (typeof step === 'number' && step > 1) setStep(step - 1);
  };

  // ===== Submit =====
  const onSubmit = async (e) => {
    e.preventDefault();
    if (submittedRef.current) return;
    if (!validateStep(step)) return;

    submittedRef.current = true;
    setSubmitting(true);

    try {
      // Upload files first
      const uploaded = [];
      for (const item of files) {
        if (!item.file) continue;
        try {
          const res = await fetch(`${cfg.apiBase}?action=upload`, {
            method: 'POST',
            headers: {
              'Content-Type': item.file.type || 'application/octet-stream',
              'X-Filename': encodeURIComponent(item.file.name),
            },
            body: item.file,
          });
          if (!res.ok) throw new Error(`Upload failed (${res.status})`);
          const json = await res.json();
          uploaded.push({
            filename: json.filename || item.file.name,
            mimeType: json.mimeType || item.file.type,
            sizeBytes: json.sizeBytes || item.file.size,
            blobUrl: json.blobUrl,
            blobPathname: json.blobPathname,
          });
        } catch (uploadErr) {
          console.error('[QuoteRequestForm] file upload failed', uploadErr);
          // Continue — partial uploads are still useful, lead is more important than attachment
        }
      }

      const payload = {
        formSessionId: sessionIdRef.current,
        name: form.name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        countryCode: country?.dialCode || null,
        countryName: country?.name || null,
        company: form.company.trim() || null,
        projectDetails: form.projectDetails.trim() || null,
        timeline: form.timeline || null,
        budget: form.budget.trim() || null,
        optIn: !!form.optIn,
        sourceUrl: window.location.href,
        files: uploaded,
      };

      const res = await fetch(cfg.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Submit failed (${res.status})`);

      // Clear saved progress
      if (sessionIdRef.current) {
        try { localStorage.removeItem(STORAGE_PREFIX + sessionIdRef.current); } catch { /* */ }
      }

      // Celebrate
      fireConfetti();
      setTimeout(fireConfetti, 200);
      setTimeout(fireConfetti, 400);

      setStep('success');
      if (typeof cfg.onSubmitted === 'function') {
        try { cfg.onSubmitted(payload); } catch { /* */ }
      }
    } catch (err) {
      console.error('[QuoteRequestForm] submit error', err);
      submittedRef.current = false;
      setErrors((er) => ({
        ...er,
        'captcha-verified': "Something went wrong submitting your request. Please try again, or email us directly.",
      }));
    } finally {
      setSubmitting(false);
    }
  };

  // ===== Welcome banner actions =====
  const onResumeSaved = () => {
    if (welcomeBanner?.sessionId) loadSession(welcomeBanner.sessionId);
    setWelcomeBanner(null);
  };

  const onStartFresh = () => {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(STORAGE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch { /* */ }
    setWelcomeBanner(null);
    sessionIdRef.current = 'form_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    startTimeRef.current = Date.now();
    setForm(emptyForm());
    setFiles([]);
    setStep(1);
  };

  // ===== Personalised titles =====
  // Step 1 always shows the time-based greeting. Later steps use the
  // user's first name once we have it, falling back to the base title.
  const personalisedTitle = (which) => {
    if (which === 'step1') return `${timeBasedGreeting()} ${cfg.step1Title}`;
    if (!userName) {
      if (which === 'step2') return cfg.step2Title;
      if (which === 'step3') return cfg.step3Title;
      if (which === 'step4') return cfg.step4Title;
      if (which === 'success') return cfg.successTitle;
    }
    if (which === 'step2') return `Thanks ${userName}! Tell us about your project`;
    if (which === 'step3') return `Great ${userName}, now let's talk timeline and budget`;
    if (which === 'step4') return `Almost done ${userName}!`;
    if (which === 'success') return `Thank you ${userName}!`;
    return '';
  };

  const greetedStep1Title = personalisedTitle('step1');

  // ===== Country list (filtered) =====
  const filteredCountries = useMemo(() => {
    const term = countrySearch.trim().toLowerCase();
    if (!term) return COUNTRIES;
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(term) ||
      c.code.toLowerCase().includes(term) ||
      c.dialCode.includes(term)
    );
  }, [countrySearch]);

  const isSuccess = step === 'success';
  const numericStep = typeof step === 'number' ? step : TOTAL_STEPS;

  return (
    <div className={`quote-request-widget ${welcomeBanner && welcomeBanner.visible ? 'has-welcome-banner' : ''}`}>
      {welcomeBanner && (
        <div className={`welcome-back-banner ${welcomeBanner.visible ? 'visible' : ''}`}>
          <div className="welcome-back-content">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="welcome-icon">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
            </svg>
            <div className="welcome-text">
              <h3 className="welcome-title">{welcomeBanner.title}</h3>
              <p className="welcome-description">{welcomeBanner.description}</p>
            </div>
            <div className="welcome-actions">
              <button type="button" className="btn-welcome-resume" onClick={onResumeSaved}>Continue where I left off</button>
              <button type="button" className="btn-welcome-dismiss" onClick={onStartFresh}>Start fresh</button>
            </div>
            <button type="button" className="welcome-close" onClick={() => setWelcomeBanner(null)}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="progress-form-container">
        <div className="progress-header">
          <div className="progress-steps">
            {STEP_LABELS.map((label, idx) => {
              const n = idx + 1;
              const cls = isSuccess || n < numericStep ? 'completed' : n === numericStep ? 'active' : '';
              return (
                <React.Fragment key={label}>
                  <div className={`progress-step ${cls}`}>
                    <div className="step-circle">
                      <span className="step-number">{n}</span>
                      <svg className="step-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <span className="step-label">{label}</span>
                  </div>
                  {idx < STEP_LABELS.length - 1 && (
                    <div className="progress-connector">
                      <div className={`connector-fill ${isSuccess || n < numericStep ? 'filled' : ''}`} />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <form className="multi-step-form" onSubmit={onSubmit} noValidate>
          {!isSuccess && (
            <div className="time-estimate-badge">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="time-icon">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span key={timeBadgeTick} className="time-text">
                {remainingMinutes === 1 ? '1 minute left' : `${remainingMinutes} minutes left`}
              </span>
            </div>
          )}

          {/* Step 1 */}
          <div className={`form-step ${step === 1 ? 'active' : ''}`}>
            <h2 className="step-title">{greetedStep1Title}</h2>
            <p className="step-description">{cfg.step1Description}</p>

            <div className="privacy-badge">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="privacy-icon">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>{cfg.privacyMessage}</span>
            </div>

            <div className="form-group">
              <label htmlFor="qr-name">{cfg.nameLabel}{!cfg.nameRequired && <span className="optional-label"> (optional)</span>}</label>
              <input
                type="text" id="qr-name" name="name"
                className={`form-input ${errors.name ? 'error' : ''}`}
                placeholder={cfg.namePlaceholder}
                value={form.name}
                onChange={(e) => { setField('name', e.target.value); if (errors.name) clearError('name'); }}
              />
              {errors.name && <span className="error-message visible">{errors.name}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="qr-email">{cfg.emailLabel}{!cfg.emailRequired && <span className="optional-label"> (optional)</span>}</label>
              <input
                type="email" id="qr-email" name="email"
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
              <label htmlFor="qr-phone">{cfg.phoneLabel}{!cfg.phoneRequired && <span className="optional-label"> (optional)</span>}</label>
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
                  type="tel" id="qr-phone" name="phone"
                  className={`form-input phone-number-input ${errors.phone ? 'error' : ''}`}
                  placeholder={cfg.phonePlaceholder}
                  value={form.phone}
                  onChange={onPhoneChange}
                />
              </div>
              {errors.phone && <span className="error-message visible">{errors.phone}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="qr-company">{cfg.companyLabel}{!cfg.companyRequired && <span className="optional-label"> (optional)</span>}</label>
              <input
                type="text" id="qr-company" name="company"
                className={`form-input ${errors.company ? 'error' : ''}`}
                placeholder={cfg.companyPlaceholder}
                value={form.company}
                onChange={(e) => { setField('company', e.target.value); if (errors.company) clearError('company'); }}
              />
              {errors.company && <span className="error-message visible">{errors.company}</span>}
            </div>
          </div>

          {/* Step 2 */}
          <div className={`form-step ${step === 2 ? 'active' : ''}`}>
            <h2 className="step-title">{personalisedTitle('step2')}</h2>
            <p className="step-description">{cfg.step2Description}</p>

            <div className="form-group">
              <label htmlFor="qr-project">{cfg.projectDetailsLabel}{!cfg.projectDetailsRequired && <span className="optional-label"> (optional)</span>}</label>
              <div className="project-caveat">
                <p className="caveat-intro">{cfg.caveatIntro}</p>
                <p className="caveat-item">{cfg.caveatPoint1}</p>
                <p className="caveat-item">{cfg.caveatPoint2}</p>
                <p className="caveat-item">{cfg.caveatPoint3}</p>
                <p className="caveat-note">{cfg.caveatNote}</p>
              </div>
              <textarea
                id="qr-project" name="project-details" rows={8}
                className={`form-input project-details-large ${errors['project-details'] ? 'error' : ''}`}
                placeholder={cfg.projectDetailsPlaceholder}
                value={form.projectDetails}
                onChange={(e) => { setField('projectDetails', e.target.value); if (errors['project-details']) clearError('project-details'); }}
              />
              {errors['project-details'] && <span className="error-message visible">{errors['project-details']}</span>}
            </div>
          </div>

          {/* Step 3 */}
          <div className={`form-step ${step === 3 ? 'active' : ''}`}>
            <h2 className="step-title">{personalisedTitle('step3')}</h2>
            <p className="step-description">{cfg.step3Description}</p>

            <div className="form-group">
              <label htmlFor="qr-timeline">{cfg.timelineLabel}{!cfg.timelineRequired && <span className="optional-label"> (optional)</span>}</label>
              <p className="timeline-caveat">{cfg.timelineCaveat}</p>
              <select
                id="qr-timeline" name="timeline"
                className={`form-input ${errors.timeline ? 'error' : ''}`}
                value={form.timeline}
                onChange={(e) => { setField('timeline', e.target.value); if (errors.timeline) clearError('timeline'); }}
              >
                <option value="">{cfg.timelinePlaceholder}</option>
                {cfg.timelineOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {errors.timeline && <span className="error-message visible">{errors.timeline}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="qr-budget">{cfg.budgetLabel}{!cfg.budgetRequired && <span className="optional-label"> (optional)</span>}</label>
              <textarea
                id="qr-budget" name="budget" rows={3}
                className={`form-input ${errors.budget ? 'error' : ''}`}
                placeholder={cfg.budgetPlaceholder}
                value={form.budget}
                onChange={(e) => { setField('budget', e.target.value); if (errors.budget) clearError('budget'); }}
              />
              {errors.budget && <span className="error-message visible">{errors.budget}</span>}
            </div>
          </div>

          {/* Step 4 */}
          <div className={`form-step ${step === 4 ? 'active' : ''}`}>
            <h2 className="step-title">{personalisedTitle('step4')}</h2>
            <p className="step-description">{cfg.step4Description}</p>

            <div className="form-group">
              <label htmlFor="qr-file">{cfg.fileUploadLabel}</label>
              <div className="file-upload-wrapper">
                <input
                  type="file" id="qr-file" name="file-upload"
                  ref={fileInputRef}
                  className="file-input"
                  accept=".pdf,.doc,.docx,.txt,.jpg,.png,.jpeg"
                  multiple
                  onChange={onFilePick}
                />
                <label htmlFor="qr-file" className="file-upload-label">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="upload-icon">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <span className="upload-text">{cfg.fileUploadButtonText}</span>
                  <span className="upload-hint">Up to {MAX_FILES} files, 20MB total</span>
                </label>
                {files.length > 0 && (
                  <div className="file-display visible">
                    <div className="file-list-header">
                      <span className="file-count">{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
                      <span className="file-total-size">{formatFileSize(totalFileSize)} / 20MB</span>
                    </div>
                    {files.map(f => (
                      <div key={f.id} className="file-item">
                        <svg className="file-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="file-info">
                          <span className="file-item-name">{f.file.name}</span>
                          <span className="file-item-size">{formatFileSize(f.file.size)}</span>
                        </div>
                        <button type="button" className="file-remove" onClick={() => removeFile(f.id)}>
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {errors['file-upload'] && <span className="error-message visible">{errors['file-upload']}</span>}
            </div>

            {cfg.showOptIn && (
              <div className="form-group">
                <div className="checkbox-wrapper">
                  <input
                    type="checkbox" id="qr-optin" name="opt-in"
                    className="checkbox-input"
                    checked={form.optIn}
                    onChange={(e) => setField('optIn', e.target.checked)}
                  />
                  <label htmlFor="qr-optin" className="checkbox-label">{cfg.optInText}</label>
                </div>
              </div>
            )}

            <div className="form-group">
              <div className="captcha-container">
                <div className="captcha-box">
                  <div className="captcha-checkbox-wrapper">
                    <input
                      type="checkbox" id="qr-captcha" name="captcha-verified"
                      className="captcha-checkbox"
                      checked={form.captchaVerified}
                      onChange={(e) => { setField('captchaVerified', e.target.checked); if (errors['captcha-verified']) clearError('captcha-verified'); }}
                    />
                    <label htmlFor="qr-captcha" className="captcha-label">
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
          </div>

          {/* Success */}
          {isSuccess && (
            <div className="form-step success-message active">
              <div className="success-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="step-title">{personalisedTitle('success')}</h2>
              <p className="step-description">{cfg.successDescription}</p>
            </div>
          )}

          {!isSuccess && (
            <div className="form-navigation" ref={navRef}>
              {step > 1 && (
                <button type="button" className="btn btn-secondary" onClick={goPrev} disabled={submitting}>{cfg.prevButtonText}</button>
              )}
              {step < TOTAL_STEPS && (
                <button type="button" className={`btn btn-primary ${pulseNext ? 'btn-pulse' : ''}`} onClick={goNext}>{cfg.nextButtonText}</button>
              )}
              {step === TOTAL_STEPS && (
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting…' : cfg.submitButtonText}
                </button>
              )}
            </div>
          )}
        </form>
      </div>

      {exitOpen && cfg.enableExitIntent && (
        <div className="exit-intent-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) { setExitOpen(false); exitShownRef.current = false; } }}>
          <div className="exit-intent-modal">
            <button type="button" className="exit-modal-close" onClick={() => setExitOpen(false)}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="exit-modal-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h3 className="exit-modal-title">
              {userName ? `Wait ${userName}! Don't leave yet` : cfg.exitIntentTitle}
            </h3>
            <p className="exit-modal-description">{cfg.exitIntentDescription}</p>
            <div className="exit-progress-info">
              <div className="exit-progress-bar">
                <div className="exit-progress-fill" style={{ width: `${Math.round((numericStep / TOTAL_STEPS) * 100)}%` }} />
              </div>
              <p className="exit-progress-text">
                You're {Math.round((numericStep / TOTAL_STEPS) * 100)}% done! Only {TOTAL_STEPS - numericStep} step{TOTAL_STEPS - numericStep !== 1 ? 's' : ''} remaining.
              </p>
            </div>
            <div className="exit-modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => { setExitOpen(false); exitShownRef.current = false; }}>
                {cfg.exitIntentContinueButton}
              </button>
              <button
                type="button" className="btn btn-secondary"
                onClick={async () => {
                  const email = form.email.trim();
                  if (!email || !isValidEmail(email)) {
                    alert("Please go back to step 1 and enter a valid email address — we need it to send you the resume link.");
                    setExitOpen(false);
                    setStep(1);
                    return;
                  }
                  if (!sessionIdRef.current) {
                    sessionIdRef.current = 'form_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
                  }
                  saveProgress();
                  try {
                    const r = await fetch(`${cfg.apiBase}?action=save-and-email`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        formSessionId: sessionIdRef.current,
                        email,
                        name: form.name.trim() || null,
                        origin: window.location.origin,
                      }),
                    });
                    if (!r.ok) throw new Error('send failed');
                    setExitOpen(false);
                    alert(`✅ We've emailed a resume link to ${email}. Check your inbox (and spam folder just in case).`);
                  } catch {
                    setExitOpen(false);
                    alert("Sorry — we couldn't send the email just now. Your progress is saved locally, so you can come back to this page any time.");
                  }
                }}
              >
                {cfg.exitIntentSaveButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuoteRequestForm;
