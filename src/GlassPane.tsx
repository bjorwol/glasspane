// @ts-nocheck – ported prototype, not yet typed for this project's strict tsconfig
import { useState, useRef, useEffect } from 'preact/hooks';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import './App.css';

/* ---------------------------------------------------------------
   GlassPane — a translucent meeting notes overlay
   The panel fills a transparent, decoration-less window that floats
   above a call. It fades on idle, ignores clicks while faded, and
   autosaves — there is no save boundary between meetings.
--------------------------------------------------------------- */

const C = {
  ink: '#EDEAE3',
  inkDim: '#9AA09B',
  inkFaint: '#6C726E',
  glass: '16, 20, 23',
  accent: '#9DBFA5',
  accentDeep: '#5F8A6C',
  amber: '#D6A24A',
  line: 'rgba(237,234,227,0.13)',
  lineSoft: 'rgba(237,234,227,0.07)',
};

const STORE_KEY = 'glasspane-sessions';
const SAVE_DEBOUNCE_MS = 800;

const todayLabel = () =>
  new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const stripHtml = (html) =>
  (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const displayName = (s) => {
  if (s.title && s.title.trim()) return s.title.trim();
  const text = stripHtml(s.html);
  return text ? text.slice(0, 60) : 'Untitled';
};

export default function GlassPane() {
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const latest = useRef(null);

  // Fade is a percentage: 0 = fully opaque, 100 = almost fully transparent.
  // It drives the panel's own background alpha directly — real compositing
  // against whatever the (genuinely transparent) window shows behind it,
  // not a blend toward a gray/white fill and not a blur.
  const [fade, setFade] = useState(0);
  const [ghost, setGhost] = useState(false);
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState('');
  const [view, setView] = useState('notes');
  const [organized, setOrganized] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [status, setStatus] = useState('pending');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [attendees, setAttendees] = useState([]);
  const [attendeeInput, setAttendeeInput] = useState('');
  const [noteListOpen, setNoteListOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [toFileOnly, setToFileOnly] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);

  // A ref mirror of the state autosave needs, kept fresh every render so
  // listeners registered once (window blur, Tauri events) never read stale
  // values without having to resubscribe on every keystroke.
  latest.current = { title, organized, status, attendees, currentId };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setSessions(JSON.parse(raw));
    } catch (e) {
      /* nothing saved yet, or unreadable */
    }
  }, []);

  useEffect(() => {
    invoke('has_anthropic_key')
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, []);

  const saveKey = async () => {
    const value = keyInput.trim();
    if (!value) return;
    setKeyBusy(true);
    setError('');
    try {
      await invoke('save_anthropic_key', { key: value });
      setHasKey(true);
      setKeyInput('');
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Could not save the key. Try again.');
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    setError('');
    try {
      await invoke('clear_anthropic_key');
      setHasKey(false);
      setKeyInput('');
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Could not clear the key. Try again.');
    } finally {
      setKeyBusy(false);
    }
  };

  const cmd = (name, val = null) => {
    editorRef.current?.focus();
    document.execCommand(name, false, val);
  };

  const insert = (html) => {
    editorRef.current?.focus();
    document.execCommand('insertHTML', false, html);
  };

  const onEditorClick = (e) => {
    const box = e.target.closest('[data-check]');
    if (!box) return;
    const on = box.getAttribute('data-check') === '1';
    box.setAttribute('data-check', on ? '0' : '1');
    box.textContent = on ? '☐' : '☑';
    box.style.color = on ? C.inkFaint : C.accent;
  };

  const writeNote = (id, extra = {}) => {
    if (!id) return;
    const L = latest.current;
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === id
          ? {
              ...s,
              title: L.title,
              html: editorRef.current?.innerHTML || '',
              organized: L.organized,
              status: L.status,
              attendees: L.attendees,
              lastEditedAt: Date.now(),
              ...extra,
            }
          : s
      );
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch (e) {
        setError('Kept for this session only. Storage is unavailable.');
      }
      return next;
    });
  };

  // A note exists in storage from the first keystroke, not from a save
  // action — there is no Save button, so this is the only boundary left.
  const ensureNote = () => {
    if (latest.current.currentId) return latest.current.currentId;
    const id = String(Date.now());
    const L = latest.current;
    const record = {
      id,
      title: L.title,
      when: todayLabel(),
      html: editorRef.current?.innerHTML || '',
      organized: L.organized,
      status: L.status,
      attendees: L.attendees,
      lastEditedAt: Date.now(),
    };
    setCurrentId(id);
    setSessions((prev) => {
      const next = [record, ...prev];
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch (e) {
        /* kept in memory only */
      }
      return next;
    });
    return id;
  };

  const flushSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const id = latest.current?.currentId;
    if (id) {
      writeNote(id);
      setSaveStatus('saved');
    }
  };

  // The red traffic-light button is a real quit, not the window's own
  // close-to-hide behavior (see the Rust gp://quit listener). The write
  // here is synchronous rather than routed through setSessions, since
  // the process exits shortly after and a deferred state commit isn't
  // guaranteed to have landed by then.
  const closeApp = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const id = latest.current?.currentId;
    if (id) {
      const L = latest.current;
      const next = sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              title: L.title,
              html: editorRef.current?.innerHTML || '',
              organized: L.organized,
              status: L.status,
              attendees: L.attendees,
              lastEditedAt: Date.now(),
            }
          : s
      );
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch (e) {
        /* best effort — quitting regardless */
      }
    }
    emit('gp://quit');
  };

  const scheduleSave = (id) => {
    setSaveStatus('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      writeNote(id);
      setSaveStatus('saved');
      saveTimer.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  const handleEditorInput = () => {
    const id = ensureNote();
    scheduleSave(id);
  };

  const handleTitleInput = (e) => {
    const value = e.currentTarget.value;
    setTitle(value);
    const id = ensureNote();
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    writeNote(id, { title: value });
    setSaveStatus('saved');
  };

  const organize = async () => {
    const raw = editorRef.current?.innerText?.trim() || '';
    if (raw.length < 15) {
      setError('Type a few notes first, then organize.');
      return;
    }
    if (!hasKey) {
      setError('Add your Anthropic API key in settings');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const prompt = `Reorganize these raw meeting notes. Respond with ONLY a JSON object, no markdown fences and no preamble.

Schema:
{"title": string, "summary": string, "sections": [{"heading": string, "bullets": [string]}], "decisions": [string], "actions": [{"task": string, "owner": string, "due": string}], "questions": [string]}

Rules:
- Keep every substantive point. Do not invent facts, names, or dates.
- A line starting with @Name means that person said or owns it. Use those names as owners.
- Unknown owner is "unassigned". Unknown date is "no date".
- Any array with nothing to put in it should be empty, not filled with guesses.

Meeting: ${title || 'Untitled'}
People on the call: ${attendees.length ? attendees.join(', ') : 'unspecified'}

Raw notes:
${raw}`;

      // The Anthropic call happens entirely in Rust (see src-tauri/src/vault.rs)
      // so the API key never enters the webview.
      const text = await invoke('organize_notes', { prompt });
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      setOrganized(parsed);
      setView('organized');
      const id = ensureNote();
      writeNote(id, { organized: parsed });
    } catch (err) {
      console.error(err);
      setError(typeof err === 'string' ? err : err?.message || 'Could not organize those notes. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const toHTML = (o) => {
    let h = `<h1>${o.title || 'Meeting'}</h1><p>${o.summary || ''}</p>`;
    (o.sections || []).forEach((s) => {
      h += `<h2>${s.heading}</h2><ul>${(s.bullets || [])
        .map((b) => `<li>${b}</li>`)
        .join('')}</ul>`;
    });
    if ((o.decisions || []).length)
      h += `<h2>Decisions</h2><ul>${o.decisions
        .map((d) => `<li>${d}</li>`)
        .join('')}</ul>`;
    if ((o.actions || []).length)
      h += `<h2>Action items</h2><ul>${o.actions
        .map(
          (a) =>
            `<li>${a.task} <em>(${a.owner}, ${a.due})</em></li>`
        )
        .join('')}</ul>`;
    if ((o.questions || []).length)
      h += `<h2>Open questions</h2><ul>${o.questions
        .map((q) => `<li>${q}</li>`)
        .join('')}</ul>`;
    return h;
  };

  const replaceNotes = () => {
    if (!organized || !editorRef.current) return;
    editorRef.current.innerHTML = toHTML(organized);
    setView('notes');
    const id = ensureNote();
    writeNote(id);
  };

  const setFiled = (next) => {
    setStatus(next);
    const id = latest.current?.currentId;
    if (id) writeNote(id, { status: next });
  };

  const load = (s) => {
    flushSave();
    setTitle(s.title || '');
    if (editorRef.current) editorRef.current.innerHTML = s.html || '';
    setOrganized(s.organized || null);
    setStatus(s.status || 'pending');
    setAttendees(s.attendees || []);
    setCurrentId(s.id);
    setView('notes');
    setNoteListOpen(false);
    setConfirmDeleteId(null);
  };

  const newNote = () => {
    flushSave();
    setTitle('');
    if (editorRef.current) editorRef.current.innerHTML = '';
    setOrganized(null);
    setStatus('pending');
    setAttendees([]);
    setAttendeeInput('');
    setCurrentId(null);
    setError('');
    setView('notes');
    setNoteListOpen(false);
    setConfirmDeleteId(null);
    setSaveStatus('saved');
  };

  // window.confirm() doesn't work here — wry's WKWebView delegate on macOS
  // doesn't implement the runJavaScriptConfirmPanel method it needs, so the
  // call just silently fails instead of showing a dialog. Confirmation is
  // an inline "are you sure" row in the note list instead (see confirmDeleteId).
  const deleteNote = (id) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch (e) {
        /* kept in memory only */
      }
      return next;
    });
    if (id === currentId) newNote();
  };

  const addAttendee = () => {
    const name = attendeeInput.trim();
    if (!name) return;
    if (attendees.includes(name)) {
      setAttendeeInput('');
      return;
    }
    const next = [...attendees, name];
    setAttendees(next);
    setAttendeeInput('');
    const id = ensureNote();
    writeNote(id, { attendees: next });
  };

  const removeAttendee = (name) => {
    const next = attendees.filter((a) => a !== name);
    setAttendees(next);
    const id = latest.current?.currentId;
    if (id) writeNote(id, { attendees: next });
  };

  // Click-through: while faded, the window ignores the cursor entirely so
  // clicks land on the call underneath. Once ignoring, mouseenter can never
  // fire again — waking relies on the global shortcut instead (see the
  // gp://wake listener below).
  useEffect(() => {
    getCurrentWindow()
      .setIgnoreCursorEvents(ghost && !active)
      .catch(() => {});
  }, [ghost, active]);

  useEffect(() => {
    let unlistenWake;
    let unlistenNewNote;
    listen('gp://wake', () => {
      setGhost(false);
      setActive(true);
      requestAnimationFrame(() => editorRef.current?.focus());
    }).then((fn) => {
      unlistenWake = fn;
    });
    listen('gp://new-note', () => {
      newNote();
    }).then((fn) => {
      unlistenNewNote = fn;
    });
    return () => {
      unlistenWake?.();
      unlistenNewNote?.();
    };
  }, []);

  // Flush any pending debounce as soon as the window or the app loses
  // focus, so a force-quit right after typing doesn't lose the last
  // sub-800ms of edits.
  useEffect(() => {
    const onBlur = () => flushSave();
    window.addEventListener('blur', onBlur);
    let unlistenFocus;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) flushSave();
      })
      .then((fn) => {
        unlistenFocus = fn;
      });
    return () => {
      window.removeEventListener('blur', onBlur);
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        newNote();
      } else if (key === 'l') {
        e.preventDefault();
        setNoteListOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toFile = sessions.filter((s) => s.status !== 'filed').length;
  const visible = ghost && !active ? 0.34 : 1;
  // 0% fade -> alpha 1 (opaque). 100% fade -> alpha 0.05 (almost fully
  // transparent, not literally 0 so the panel edge stays findable).
  const alpha = 1 - (fade / 100) * 0.95;

  const filteredSessions = sessions
    .filter((s) => !toFileOnly || s.status !== 'filed')
    .filter((s) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        displayName(s).toLowerCase().includes(q) ||
        stripHtml(s.html).toLowerCase().includes(q)
      );
    })
    .sort((a, b) => (b.lastEditedAt || 0) - (a.lastEditedAt || 0));

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap');
        .gp-ed { outline: none; }
        .gp-ed h1 { font-size: 1.45rem; font-weight: 600; letter-spacing: -0.01em; margin: 0.7em 0 0.25em; }
        .gp-ed h2 { font-size: 1.15rem; font-weight: 600; margin: 0.7em 0 0.2em; }
        .gp-ed h3 { font-size: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin: 0.7em 0 0.2em; color: ${C.inkDim}; }
        .gp-ed p, .gp-ed div { margin: 0.25em 0; }
        .gp-ed ul { list-style: disc; padding-left: 1.35em; margin: 0.3em 0; }
        .gp-ed ol { list-style: decimal; padding-left: 1.35em; margin: 0.3em 0; }
        .gp-ed li { margin: 0.15em 0; }
        .gp-ed em { color: ${C.inkDim}; font-style: normal; font-size: 0.85em; }
        .gp-ed [data-check] { cursor: pointer; user-select: none; margin-right: 0.35em; }
        .gp-ed:empty:before { content: attr(data-ph); color: ${C.inkFaint}; }
        .gp-ed::-webkit-scrollbar { width: 5px; }
        .gp-ed::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 3px; }
        .gp-slider { -webkit-appearance: none; appearance: none; height: 2px; border-radius: 2px; outline: none; }
        .gp-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 11px; border-radius: 50%; background: ${C.accent}; cursor: pointer; }
        .gp-slider::-moz-range-thumb { width: 11px; height: 11px; border: none; border-radius: 50%; background: ${C.accent}; cursor: pointer; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      {/* the pane — fills the whole (transparent, decoration-less) window */}
      <div
        className="relative flex h-full w-full flex-col"
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => setActive(false)}
        onfocusin={() => setActive(true)}
        style={{
          opacity: visible,
          transition: 'opacity 340ms ease',
          background: `rgba(${C.glass}, ${alpha})`,
          backdropFilter: 'blur(18px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
          border: `1px solid ${C.line}`,
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          color: C.ink,
        }}
      >
        {/* title bar — also the window's drag handle, since decorations are off */}
        <div
          data-tauri-drag-region="deep"
          className="flex items-center gap-2 px-3"
          style={{ height: 40, borderBottom: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
        >
          <TrafficLights
            onClose={closeApp}
            onMinimize={() => getCurrentWindow().minimize()}
            onMaximize={() => getCurrentWindow().toggleMaximize()}
          />
          <input
            data-tauri-drag-region="false"
            value={title}
            onInput={handleTitleInput}
            placeholder="Untitled meeting"
            className="bg-transparent"
            style={{
              outline: 'none',
              border: 'none',
              color: C.ink,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              flex: '0 1 auto',
              minWidth: 40,
              width: 170,
            }}
          />
          <div className="flex-1" />
          <button
            data-tauri-drag-region="false"
            onClick={() => {
              setSettingsOpen(false);
              setNoteListOpen(!noteListOpen);
            }}
            style={{
              ...chipStyle,
              color: noteListOpen ? C.accent : toFile > 0 ? C.amber : C.inkDim,
            }}
          >
            {sessions.length === 0
              ? 'History'
              : toFile > 0
              ? `${toFile} to file`
              : `${sessions.length} filed`}
          </button>
          <button
            data-tauri-drag-region="false"
            onClick={() => {
              setNoteListOpen(false);
              setSettingsOpen(!settingsOpen);
            }}
            title="Settings"
            aria-label="Settings"
            style={{ ...chipStyle, color: settingsOpen ? C.accent : C.inkDim, fontSize: 13 }}
          >
            ⚙
          </button>
        </div>

        {/* attendees — editable list; click a chip to tag who is talking */}
        <div
          className="flex flex-wrap items-center gap-1 px-3"
          style={{ padding: '8px 12px', borderBottom: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
        >
          {attendees.map((name) => (
            <span
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                border: `1px solid ${C.line}`,
                borderRadius: 20,
                padding: '2px 4px 2px 9px',
              }}
            >
              <button
                type="button"
                onClick={() => insert(`<strong style="color:${C.accent}">@${name}</strong>&nbsp;`)}
                style={{ ...chipStyle, padding: 0 }}
              >
                @{name}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttendee(name);
                }}
                title={`Remove ${name}`}
                style={{
                  ...chipStyle,
                  padding: 0,
                  width: 16,
                  height: 16,
                  color: C.inkFaint,
                  borderRadius: '50%',
                }}
              >
                &times;
              </button>
            </span>
          ))}
          <input
            value={attendeeInput}
            onInput={(e) => setAttendeeInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addAttendee();
              }
            }}
            placeholder="Add name"
            className="bg-transparent"
            style={{
              outline: 'none',
              border: 'none',
              color: C.ink,
              fontSize: 11.5,
              width: 76,
            }}
          />
        </div>

        {view === 'notes' ? (
          <>
            {/* formatting */}
            <div
              className="flex flex-wrap items-center gap-1"
              style={{ padding: '7px 10px', borderBottom: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
            >
              <Tool onClick={() => cmd('formatBlock', '<h1>')}>H1</Tool>
              <Tool onClick={() => cmd('formatBlock', '<h2>')}>H2</Tool>
              <Tool onClick={() => cmd('formatBlock', '<h3>')}>H3</Tool>
              <Tool onClick={() => cmd('formatBlock', '<p>')}>Body</Tool>
              <Div />
              <Tool onClick={() => cmd('bold')} style={{ fontWeight: 700 }}>B</Tool>
              <Tool onClick={() => cmd('italic')} style={{ fontStyle: 'italic' }}>I</Tool>
              <Tool onClick={() => cmd('underline')} style={{ textDecoration: 'underline' }}>U</Tool>
              <Div />
              <Tool onClick={() => cmd('insertUnorderedList')}>&bull;</Tool>
              <Tool onClick={() => cmd('insertOrderedList')}>1.</Tool>
              <Tool
                onClick={() =>
                  insert(`<span data-check="0" style="color:${C.inkFaint}">☐</span>&nbsp;`)
                }
              >
                &#9744;
              </Tool>
              <Div />
              <Tool onClick={() => cmd('fontSize', '2')} style={{ fontSize: 10 }}>A</Tool>
              <Tool onClick={() => cmd('fontSize', '3')} style={{ fontSize: 12 }}>A</Tool>
              <Tool onClick={() => cmd('fontSize', '5')} style={{ fontSize: 15 }}>A</Tool>
            </div>

            <div
              ref={editorRef}
              contentEditable
              className="gp-ed flex-1"
              data-ph="Start typing. Tag who is speaking with the chips above."
              onClick={onEditorClick}
              onInput={handleEditorInput}
              style={{
                padding: '14px 16px',
                overflowY: 'auto',
                fontSize: 14,
                lineHeight: 1.55,
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              }}
            />
          </>
        ) : (
          <div className="flex-1" style={{ overflowY: 'auto', padding: '16px' }}>
            <Recap o={organized} />
          </div>
        )}

        {error && (
          <p style={{ padding: '0 16px 8px', fontSize: 11.5, color: C.amber, flexShrink: 0 }}>
            {error}
          </p>
        )}

        {/* controls */}
        <div
          className="flex items-center gap-3"
          style={{ padding: '10px 12px', borderTop: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
        >
          <span style={{ fontSize: 10.5, color: C.inkFaint, letterSpacing: '0.01em' }}>Fade</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={fade}
            onInput={(e) => setFade(parseInt(e.currentTarget.value, 10))}
            className="gp-slider"
            aria-label="Fade — panel transparency"
            title={`${fade}% faded`}
            style={{ width: 62, background: C.line }}
          />
          <button
            onClick={() => setGhost(!ghost)}
            style={{ ...chipStyle, color: ghost ? C.accent : C.inkFaint }}
            title="Dim and click-through the panel when you're not using it"
          >
            Auto-dim
          </button>
          <div className="flex-1" />
          <span style={{ fontSize: 11.5, color: C.inkFaint, letterSpacing: '0.01em' }}>
            {saveStatus === 'saving' ? 'Saving' : 'Saved'}
          </span>
          <button
            onClick={() => setFiled(status === 'filed' ? 'pending' : 'filed')}
            title="Mark whether this is in Google Docs yet"
            style={{
              ...chipStyle,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              borderRadius: 20,
              padding: '3px 9px',
              color: status === 'filed' ? C.accent : C.amber,
              border: `1px solid ${
                status === 'filed' ? 'rgba(157,191,165,0.32)' : 'rgba(214,162,74,0.32)'
              }`,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: status === 'filed' ? C.accentDeep : C.amber,
              }}
            />
            {status === 'filed' ? 'In Docs' : 'To file'}
          </button>
          {view === 'organized' ? (
            <>
              <button onClick={() => setView('notes')} style={{ ...chipStyle, color: C.inkDim }}>
                Back
              </button>
              <button onClick={replaceNotes} style={primaryStyle}>
                Use this
              </button>
            </>
          ) : (
            <button
              onClick={organize}
              disabled={busy || !hasKey}
              title={hasKey ? undefined : 'Add your Anthropic API key in settings'}
              style={{ ...primaryStyle, opacity: busy || !hasKey ? 0.4 : 1 }}
            >
              {busy ? 'Organizing' : 'Organize'}
            </button>
          )}
        </div>

        {/* note list — slides in over the panel body, same glass treatment */}
        <div
          style={{
            position: 'absolute',
            top: 40,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            background: `rgba(${C.glass}, ${alpha})`,
            backdropFilter: 'blur(18px) saturate(1.15)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
            transform: noteListOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 220ms ease',
            pointerEvents: noteListOpen ? 'auto' : 'none',
            zIndex: 5,
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: '10px 12px', borderBottom: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
          >
            <span
              style={{
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: C.inkFaint,
              }}
            >
              Notes
            </span>
            <button onClick={newNote} style={{ ...chipStyle, color: C.accent }}>
              + New note
            </button>
          </div>
          <div
            className="flex items-center gap-2"
            style={{ padding: '8px 12px', borderBottom: `1px solid ${C.lineSoft}`, flexShrink: 0 }}
          >
            <input
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
              placeholder="Search notes"
              className="flex-1 bg-transparent"
              style={{
                outline: 'none',
                border: `1px solid ${C.line}`,
                borderRadius: 6,
                padding: '4px 8px',
                color: C.ink,
                fontSize: 12,
              }}
            />
            <button
              onClick={() => setToFileOnly(!toFileOnly)}
              style={{
                ...chipStyle,
                color: toFileOnly ? C.amber : C.inkDim,
                border: `1px solid ${toFileOnly ? 'rgba(214,162,74,0.4)' : C.line}`,
                borderRadius: 6,
              }}
            >
              To file only
            </button>
          </div>
          <div className="flex-1" style={{ overflowY: 'auto' }}>
            {filteredSessions.length === 0 ? (
              <p style={{ padding: '14px', fontSize: 12, color: C.inkFaint }}>
                {sessions.length === 0
                  ? 'Nothing here yet. Notes save automatically as you type.'
                  : 'No notes match.'}
              </p>
            ) : (
              filteredSessions.map((s) => {
                const filed = s.status === 'filed';

                if (confirmDeleteId === s.id) {
                  return (
                    <div
                      key={s.id}
                      className="flex w-full items-center gap-2"
                      style={{ padding: '8px 14px', fontSize: 12 }}
                    >
                      <span
                        className="flex-1"
                        style={{
                          color: C.amber,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Delete "{displayName(s)}"?
                      </span>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        style={{ ...chipStyle, color: C.inkDim, flexShrink: 0 }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          setConfirmDeleteId(null);
                          deleteNote(s.id);
                        }}
                        style={{ ...chipStyle, color: '#E06C5B', flexShrink: 0 }}
                      >
                        Delete
                      </button>
                    </div>
                  );
                }

                return (
                  <button
                    key={s.id}
                    onClick={() => load(s)}
                    className="flex w-full items-center gap-2"
                    style={{
                      padding: '8px 14px',
                      fontSize: 12,
                      textAlign: 'left',
                      background:
                        s.id === currentId ? 'rgba(237,234,227,0.05)' : 'transparent',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: filed ? C.accentDeep : C.amber,
                      }}
                    />
                    <span
                      className="flex-1"
                      style={{
                        color: filed ? C.inkDim : C.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {displayName(s)}
                    </span>
                    <span style={{ fontSize: 10.5, color: C.inkFaint, flexShrink: 0 }}>
                      {s.organized ? 'organized' : 'raw'}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        flexShrink: 0,
                        width: 54,
                        textAlign: 'right',
                        color: filed ? C.accent : C.amber,
                      }}
                    >
                      {filed ? 'In Docs' : 'To file'}
                    </span>
                    <span style={{ fontSize: 10.5, color: C.inkFaint, flexShrink: 0 }}>
                      {s.when}
                    </span>
                    <span
                      role="button"
                      title="Delete note"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(s.id);
                      }}
                      style={{ fontSize: 13, color: C.inkFaint, flexShrink: 0, padding: '0 2px' }}
                    >
                      &times;
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* settings — same slide-in treatment as the note list */}
        <div
          style={{
            position: 'absolute',
            top: 40,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            background: `rgba(${C.glass}, ${alpha})`,
            backdropFilter: 'blur(18px) saturate(1.15)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
            transform: settingsOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 220ms ease',
            pointerEvents: settingsOpen ? 'auto' : 'none',
            zIndex: 5,
            padding: '14px',
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ marginBottom: 16 }}
          >
            <span
              style={{
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: C.inkFaint,
              }}
            >
              Settings
            </span>
            <button onClick={() => setSettingsOpen(false)} style={{ ...chipStyle, color: C.inkDim }}>
              Done
            </button>
          </div>

          <p style={{ fontSize: 12, color: C.inkDim, marginBottom: 8 }}>Anthropic API key</p>

          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                flexShrink: 0,
                background: hasKey ? C.accentDeep : C.amber,
              }}
            />
            <span style={{ fontSize: 12, color: hasKey ? C.accent : C.amber }}>
              {hasKey ? 'Key saved' : 'No key set'}
            </span>
          </div>

          <input
            type="password"
            value={keyInput}
            onInput={(e) => setKeyInput(e.currentTarget.value)}
            placeholder={hasKey ? 'Replace saved key' : 'sk-ant-...'}
            autoComplete="off"
            spellCheck={false}
            style={{
              outline: 'none',
              border: `1px solid ${C.line}`,
              borderRadius: 6,
              padding: '6px 8px',
              color: C.ink,
              fontSize: 12.5,
              background: 'transparent',
              width: '100%',
              marginBottom: 10,
            }}
          />

          <div className="flex items-center gap-2">
            <button
              onClick={saveKey}
              disabled={keyBusy || !keyInput.trim()}
              style={{
                ...primaryStyle,
                opacity: keyBusy || !keyInput.trim() ? 0.45 : 1,
              }}
            >
              Save
            </button>
            {hasKey && (
              <button
                onClick={clearKey}
                disabled={keyBusy}
                style={{ ...chipStyle, color: C.inkFaint }}
              >
                Clear
              </button>
            )}
          </div>

          <p style={{ marginTop: 14, fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
            Stored encrypted on this device. Organize sends your notes to Anthropic
            using this key — it never leaves this app otherwise.
          </p>
        </div>
      </div>
    </div>
  );
}

function Recap({ o }) {
  if (!o) return null;
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{o.title}</h2>
      <p style={{ marginTop: 6, color: C.inkDim, fontSize: 12.5 }}>{o.summary}</p>

      {(o.sections || []).map((s, i) => (
        <Block key={i} label={s.heading}>
          {(s.bullets || []).map((b, j) => (
            <Line key={j}>{b}</Line>
          ))}
        </Block>
      ))}

      {(o.decisions || []).length > 0 && (
        <Block label="Decisions">
          {o.decisions.map((d, i) => (
            <Line key={i} mark={C.accent}>
              {d}
            </Line>
          ))}
        </Block>
      )}

      {(o.actions || []).length > 0 && (
        <Block label="Action items">
          {o.actions.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
              <span style={{ color: C.amber, flexShrink: 0 }}>&#9744;</span>
              <span>
                {a.task}
                <span style={{ color: C.inkFaint, fontSize: 11.5, marginLeft: 6 }}>
                  {a.owner} &middot; {a.due}
                </span>
              </span>
            </div>
          ))}
        </Block>
      )}

      {(o.questions || []).length > 0 && (
        <Block label="Open questions">
          {o.questions.map((q, i) => (
            <Line key={i} mark={C.inkFaint}>
              {q}
            </Line>
          ))}
        </Block>
      )}
    </div>
  );
}

function Block({ label, children }) {
  return (
    <div style={{ marginTop: 18 }}>
      <p
        style={{
          fontSize: 10.5,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: C.inkFaint,
          borderBottom: `1px solid ${C.lineSoft}`,
          paddingBottom: 5,
          marginBottom: 7,
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

function Line({ children, mark }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span style={{ color: mark || C.inkFaint, flexShrink: 0 }}>&mdash;</span>
      <span>{children}</span>
    </div>
  );
}

function Tool({ children, onClick, style }) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        minWidth: 24,
        height: 24,
        borderRadius: 5,
        fontSize: 11.5,
        color: C.inkDim,
        border: `1px solid transparent`,
        background: 'transparent',
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(237,234,227,0.08)';
        e.currentTarget.style.color = C.ink;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = C.inkDim;
      }}
    >
      {children}
    </button>
  );
}

function Div() {
  return <span style={{ width: 1, height: 14, background: C.line, margin: '0 3px' }} />;
}

// macOS traffic lights. Hovering any one of the three reveals the glyphs on
// all three at once, matching native behavior.
function TrafficLights({ onClose, onMinimize, onMaximize }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      data-tauri-drag-region="false"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
    >
      <TrafficLight color="#FF5F57" glyph="×" hover={hover} onClick={onClose} title="Close" />
      <TrafficLight color="#FEBC2E" glyph="−" hover={hover} onClick={onMinimize} title="Minimize" />
      <TrafficLight color="#28C840" glyph="⤡" hover={hover} onClick={onMaximize} title="Maximize" />
    </div>
  );
}

function TrafficLight({ color, glyph, hover, onClick, title }) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: color,
        border: '0.5px solid rgba(0,0,0,0.2)',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        fontSize: 8,
        color: 'rgba(0,0,0,0.55)',
      }}
    >
      {hover ? glyph : ''}
    </button>
  );
}

const chipStyle = {
  fontSize: 11.5,
  color: C.inkDim,
  background: 'transparent',
  border: 'none',
  padding: '3px 6px',
  borderRadius: 5,
  letterSpacing: '0.01em',
};

const primaryStyle = {
  fontSize: 11.5,
  fontWeight: 500,
  color: '#0F1416',
  background: C.accent,
  border: 'none',
  padding: '5px 12px',
  borderRadius: 6,
  letterSpacing: '0.01em',
};
