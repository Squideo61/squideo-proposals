import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smile } from 'lucide-react';
import { BRAND } from '../theme.js';

// A dependency-free emoji picker for every place the CRM writes an email.
//
// No library and no CDN: the app's CSP blocks third-party fetches, and a full
// emoji dataset is megabytes for a panel that only ever needs the couple of
// hundred people actually put in a work email. Each entry is one string —
// the character, then its search words — which keeps the list readable and
// the parse trivial (emoji never contain a space, ZWJ sequences included).

const CATEGORIES = [
  {
    key: 'smileys',
    label: 'Smileys',
    items: [
      '😀 grinning smile happy', '😃 smiley happy joy', '😄 grin happy laugh', '😁 beaming grin',
      '😆 laughing lol haha', '😅 sweat laugh phew relief', '🤣 rofl rolling laughing',
      '😂 joy tears laughing crying', '🙂 slight smile', '🙃 upside down silly',
      '😉 wink', '😊 blush smile pleased', '😇 innocent halo angel', '🥰 love hearts adore',
      '😍 heart eyes love', '😘 kiss blowing', '😋 yum tasty delicious', '😎 cool sunglasses',
      '🤩 star struck amazed wow', '🥳 partying celebrate party', '😏 smirk',
      '😐 neutral straight face', '😬 grimace awkward eek', '🤐 zipper quiet secret',
      '🤔 thinking hmm think', '🤨 raised eyebrow suspicious', '😮 wow surprised open mouth',
      '😲 astonished shocked', '🥺 pleading please puppy eyes', '😢 cry sad tear',
      '😭 sobbing crying loud', '😤 triumph huff determined', '😱 scream fear shocked',
      '🤯 mind blown exploding head', '😴 sleeping zzz tired', '🤒 sick ill thermometer',
      '🤗 hug hugging', '🤝 handshake deal agreed', '🫶 heart hands love thanks',
    ],
  },
  {
    key: 'gestures',
    label: 'Gestures & people',
    items: [
      '👍 thumbs up yes good approve', '👎 thumbs down no bad', '👌 ok perfect nice',
      '🤞 fingers crossed luck hope', '✌️ peace victory', '🤙 call me shaka',
      '👏 clap applause well done', '🙌 raising hands praise yay', '🙏 pray thanks please grateful',
      '💪 muscle strong flex', '👋 wave hi hello bye', '🤚 hand stop raised',
      '👀 eyes look watching', '🧠 brain smart idea', '👉 point right this',
      '👈 point left', '☝️ point up', '👇 point down below',
      '✍️ writing hand note', '🤷 shrug dunno', '🙋 raising hand volunteer question',
      '👨‍💻 developer laptop working', '👩‍💻 developer laptop working', '🧑‍🤝‍🧑 people team',
      '👥 people team group', '🎬 clapper film shoot action', '🎥 camera filming video',
      '🎤 microphone voiceover audio', '🎧 headphones listen audio', '🗣️ speaking talk voice',
    ],
  },
  {
    key: 'hearts',
    label: 'Hearts & symbols',
    items: [
      '❤️ red heart love', '🧡 orange heart', '💛 yellow heart', '💚 green heart',
      '💙 blue heart', '💜 purple heart', '🖤 black heart', '🤍 white heart',
      '💖 sparkling heart', '💯 hundred perfect score', '✅ tick check done yes complete',
      '☑️ ballot tick checkbox', '❌ cross no wrong error', '⚠️ warning caution careful',
      '❗ exclamation important', '❓ question ask', '⭐ star favourite', '🌟 glowing star',
      '✨ sparkles new shiny', '🔥 fire hot great', '⚡ zap fast lightning power',
      '🎉 party popper celebrate congrats', '🎊 confetti celebrate', '🏆 trophy win award',
      '🥇 gold medal first winner', '🚀 rocket launch fast growth', '💡 bulb idea',
      '🔔 bell notification reminder', '⏰ alarm clock time deadline', '⏳ hourglass waiting time',
      '📈 chart up growth results', '📉 chart down decline', '💰 money bag budget',
      '💷 pound money gbp', '💳 card payment invoice', '🔒 lock secure private',
      '♻️ recycle reuse', '➡️ arrow right next', '🔗 link url',
    ],
  },
  {
    key: 'objects',
    label: 'Work & objects',
    items: [
      '📧 email envelope mail', '📨 incoming mail', '📩 envelope arrow send',
      '📎 paperclip attachment', '📌 pin pinned', '📝 memo note write',
      '📄 page document file', '📁 folder files', '📊 bar chart data report',
      '📅 calendar date schedule', '🗓️ calendar spiral diary', '🕒 clock time three',
      '💻 laptop computer', '🖥️ desktop monitor screen', '📱 phone mobile',
      '☎️ telephone call', '📞 phone receiver call', '🖊️ pen sign',
      '✏️ pencil edit', '📋 clipboard list brief', '📦 package delivery',
      '🛠️ tools fix build', '⚙️ gear settings', '🔍 magnifying search look',
      '💬 speech bubble comment feedback', '💭 thought bubble', '🗒️ notepad notes',
      '📢 loudspeaker announce marketing', '📣 megaphone shout promo', '🏷️ label tag price',
      '🎯 target goal aim', '🧾 receipt invoice bill', '✉️ envelope letter',
    ],
  },
  {
    key: 'nature',
    label: 'Food & nature',
    items: [
      '☕ coffee brew tea', '🍵 tea green', '🍺 beer pint drink', '🍻 cheers beers',
      '🥂 champagne cheers celebrate', '🍾 bottle pop celebrate', '🍽️ plate lunch dinner',
      '🍕 pizza', '🍰 cake slice birthday', '🎂 birthday cake', '🍪 biscuit cookie',
      '🍫 chocolate', '🌞 sun sunny', '🌤️ sun cloud weather',
      '🌧️ rain wet', '❄️ snow cold winter', '🌈 rainbow', '🌱 seedling growth new',
      '🌳 tree nature', '🌍 earth globe world', '🐶 dog puppy', '🐱 cat kitten',
      '🦑 squid squideo', '🐙 octopus', '🐝 bee busy', '🦄 unicorn magic',
      '✈️ plane travel flight', '🚗 car drive', '🏠 house home office',
    ],
  },
];

// Flattened once: [{ char, words, category }] for searching.
export const EMOJI_ENTRIES = CATEGORIES.flatMap((cat) =>
  cat.items.map((entry) => {
    const sp = entry.indexOf(' ');
    return { char: entry.slice(0, sp), words: entry.slice(sp + 1), cat: cat.key };
  }),
);
// De-duped char → entry, so a repeated emoji (e.g. 🥳) resolves to one name.
const ALL = EMOJI_ENTRIES;
const BY_CHAR = new Map(ALL.map((e) => [e.char, e]));

const RECENT_KEY = 'sq_emoji_recent';
const RECENT_MAX = 16;

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function pushRecent(char) {
  try {
    const next = [char, ...loadRecent().filter((c) => c !== char)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch { return loadRecent(); }
}

// Drop an emoji in at the caret of a contentEditable, or on the end when the
// caret is elsewhere (the picker button deliberately doesn't steal focus, but
// the editor may never have had it). Returns the new innerHTML so the caller
// can push it into state, or null if there was no element.
export function insertEmojiIntoEditable(el, emoji) {
  if (!el) return null;
  el.focus();
  const sel = window.getSelection();
  const inEditor = sel && sel.rangeCount && el.contains(sel.anchorNode);
  if (!inEditor) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // to the end
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  // insertText keeps it a plain text node (and undoable); insertHTML is the
  // fallback for the rare browser that refuses the first.
  if (!document.execCommand('insertText', false, emoji)) {
    document.execCommand('insertHTML', false, emoji);
  }
  return el.innerHTML;
}

// Same for a plain <input>/<textarea>: splice at the caret and hand the new
// value back to React, then put the caret after what was inserted.
export function insertEmojiIntoInput(el, emoji, setValue) {
  if (!el) return;
  const value = el.value || '';
  const start = el.selectionStart == null ? value.length : el.selectionStart;
  const end = el.selectionEnd == null ? start : el.selectionEnd;
  const next = value.slice(0, start) + emoji + value.slice(end);
  setValue(next);
  const caret = start + emoji.length;
  // After React has re-rendered the controlled value.
  requestAnimationFrame(() => {
    try { el.focus(); el.setSelectionRange(caret, caret); } catch { /* detached */ }
  });
}

// The panel itself. Kept separate from the button so a caller with its own
// trigger can drop it wherever it likes.
export function EmojiPanel({ onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(loadRecent);
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return null;
    const seen = new Set();
    const out = [];
    for (const e of ALL) {
      if (seen.has(e.char)) continue;
      if (!e.words.includes(q) && !e.words.split(' ').some((w) => w.startsWith(q))) continue;
      seen.add(e.char);
      out.push(e);
    }
    return out;
  }, [q]);

  const choose = (char) => {
    setRecent(pushRecent(char));
    onPick(char);
  };

  const cell = {
    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 19, lineHeight: 1, background: 'transparent', border: 'none', borderRadius: 6,
    cursor: 'pointer', padding: 0,
    // Emoji render as flat glyphs in some fonts on Windows unless the colour
    // font is asked for by name.
    fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',
  };
  const heading = {
    fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
    color: BRAND.muted, padding: '8px 4px 4px',
  };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 1 };

  const Cell = ({ e }) => (
    <button
      type="button"
      // Never let the click blur the editor — the caret is where this lands.
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={() => choose(e.char)}
      title={e.words.split(' ')[0]}
      aria-label={e.words.split(' ')[0]}
      style={cell}
      onMouseEnter={(ev) => { ev.currentTarget.style.background = '#EEF3F6'; }}
      onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
    >
      {e.char}
    </button>
  );

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 'min(292px, calc(100vw - 32px))',
        background: '#fff', border: '1px solid ' + BRAND.border, borderRadius: 8,
        boxShadow: '0 8px 24px rgba(15,42,61,0.18)', overflow: 'hidden',
      }}
    >
      <div style={{ padding: 6, borderBottom: '1px solid ' + BRAND.border }}>
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
            // Enter picks the first match, so search-and-go needs no mouse.
            if (e.key === 'Enter' && results?.length) { e.preventDefault(); choose(results[0].char); }
          }}
          placeholder="Search emoji"
          aria-label="Search emoji"
          style={{ width: '100%', fontSize: 12.5, padding: '5px 8px' }}
          // The panel opens without stealing focus so the caret stays put;
          // clicking into the search box is a deliberate second action.
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
      <div style={{ maxHeight: 232, overflowY: 'auto', padding: '0 6px 8px' }}>
        {results ? (
          results.length ? (
            <div style={{ ...grid, paddingTop: 8 }}>
              {results.map((e) => <Cell key={e.char} e={e} />)}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic', padding: '14px 4px' }}>
              Nothing matches “{query.trim()}”.
            </div>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <div style={heading}>Recent</div>
                <div style={grid}>
                  {recent.map((c) => <Cell key={'r' + c} e={BY_CHAR.get(c) || { char: c, words: 'emoji' }} />)}
                </div>
              </>
            )}
            {CATEGORIES.map((cat) => (
              <React.Fragment key={cat.key}>
                <div style={heading}>{cat.label}</div>
                <div style={grid}>
                  {cat.items.map((entry, i) => {
                    const sp = entry.indexOf(' ');
                    const e = { char: entry.slice(0, sp), words: entry.slice(sp + 1) };
                    return <Cell key={cat.key + i} e={e} />;
                  })}
                </div>
              </React.Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const PANEL_W = 292;
const PANEL_H = 290;

// Where the panel goes for a given trigger. Fixed coordinates, flipped to the
// other side of the button when the preferred side has no room and clamped to
// the viewport, so it never opens off-screen on a phone.
export function panelPosition(rect, placement, align, viewport = null) {
  const vw = viewport ? viewport.w : window.innerWidth;
  const vh = viewport ? viewport.h : window.innerHeight;
  const w = Math.min(PANEL_W, vw - 16);
  let left = align === 'right' ? rect.right - w : rect.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  const above = rect.top - PANEL_H - 6;
  const below = rect.bottom + 6;
  let top;
  if (placement === 'top') top = above >= 8 ? above : Math.min(below, vh - PANEL_H - 8);
  else top = below + PANEL_H <= vh - 8 ? below : Math.max(8, above);
  return { left, top: Math.max(8, top), width: w };
}

// Trigger + popover. `placement` says which side of the button the panel prefers
// ('top' suits a toolbar pinned under the editor, 'bottom' a button above it);
// `align` which edge it hangs from.
//
// The panel is portalled to the body and positioned fixed rather than absolute:
// every composer wraps its editor in an `overflow: hidden` box, which would
// otherwise crop it.
export function EmojiPickerButton({
  onPick, title = 'Insert emoji', placement = 'top', align = 'left',
  buttonStyle = null, children = null,
}) {
  const [pos, setPos] = useState(null);
  const open = !!pos;
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    setPos(panelPosition(el.getBoundingClientRect(), placement, align));
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setPos(null);
    };
    // Escape closes the panel and stops there: the composers this sits in hang
    // their own Escape handlers off window, and one keypress must not close the
    // panel AND the modal behind it. A document-level bubble listener runs
    // before window's, so stopping propagation here is enough.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setPos(null);
    };
    // Capture, so scrolling any container the button sits in keeps the panel
    // stuck to it rather than leaving it floating mid-screen.
    const onMove = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const fallbackStyle = {
    background: 'transparent', border: '1px solid transparent', borderRadius: 4,
    cursor: 'pointer', color: BRAND.ink, fontSize: 13, lineHeight: 1,
    padding: '4px 7px', minWidth: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        // preventDefault so opening the picker doesn't blur the editor and
        // lose the caret the emoji is going to land at.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? setPos(null) : place())}
        style={buttonStyle ? { ...buttonStyle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } : fallbackStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#EEF3F6'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        {children || <Smile size={15} />}
      </button>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 3000 }}>
          <EmojiPanel onPick={onPick} onClose={() => setPos(null)} />
        </div>,
        document.body,
      )}
    </>
  );
}
