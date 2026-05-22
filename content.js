// ============================================================
// TUNABLE CONFIG — adjust these to control autofill pacing.
// ============================================================
// Delay between filling each regular field (ms). Increase to slow down.
const AUTOFILL_DELAY_BETWEEN_FIELDS_MS = 280;
// Extra pause before any button click fires (gives the form time to settle).
const AUTOFILL_DELAY_BEFORE_BUTTON_MS = 550;
// Extra pause between consecutive button clicks (rare, but e.g. multi-step submits).
const AUTOFILL_DELAY_BETWEEN_BUTTONS_MS = 650;

// Which DOM events to dispatch after writing a value into a text input.
// Some sites fire validation/analytics on BOTH `input` and `change`, doubling network
// calls. React/Vue forms only need `input`. If you see duplicated requests, set
// DISPATCH_CHANGE_EVENT to false.
const AUTOFILL_DISPATCH_INPUT_EVENT = true;
const AUTOFILL_DISPATCH_CHANGE_EVENT = false;

// Minimum gap (ms) between successive autofill runs triggered by the wizard
// MutationObserver. Prevents the observer from re-firing engine right after a normal
// run completes (which would double-submit on the same page).
const AUTOFILL_OBSERVER_MIN_INTERVAL_MS = 1500;
// ============================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let isPicking = false;
let isAutofilling = false; // concurrency guard — only one runExecutionEngine at a time
let activeProfileId = null;
let hoveredElement = null;
let activeProfileFields = [];
let pendingDropdown = null; // { selector, triggerEl } — two-step custom dropdown capture
let pendingDate = null; // { input, selector, initialValue, interval, timeout } — date picker capture
let bannerEl = null;
let editorEl = null;
let overlayEl = null;
let closeBtnEl = null;
let capturedThisSession = 0;
let recentDropdownCaptureAt = 0; // suppress the trailing click right after a mousedown capture
let undoStack = []; // [{selector, previousValue, element}] for current picker session

const INTERACTIVE_SELECTOR =
  'input, select, textarea, button, label[for], a[href], ' +
  '[role="radio"], [role="checkbox"], [role="combobox"], [role="listbox"], [role="button"], ' +
  '[contenteditable="true"]';

const DROPDOWN_HINT_SELECTOR =
  '[class*="select" i], [class*="dropdown" i], [class*="combobox" i]';

const style = document.createElement('style');
style.innerHTML = `
  .qa-autoflow-hover { outline: 3px solid #10b981 !important; background-color: rgba(16, 185, 129, 0.1) !important; cursor: crosshair !important; transition: all 0.1s; }
  .qa-autoflow-picked { background-color: rgba(16, 185, 129, 0.25) !important; border: 2px dashed #10b981 !important; }
  .qa-autoflow-pending { outline: 3px dashed #f59e0b !important; background-color: rgba(245, 158, 11, 0.1) !important; }
  #qa-autoflow-banner {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; padding: 10px 16px; border-radius: 8px;
    background: #111827; color: #fff; font: 500 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25); pointer-events: none;
    max-width: 90vw; text-align: center;
  }
  #qa-autoflow-banner.qa-warn { background: #b45309; }
  #qa-autoflow-banner.qa-ok { background: #047857; }
  #qa-autoflow-editor {
    position: absolute; z-index: 2147483647; min-width: 280px; max-width: 380px;
    background: #111827; color: #fff; padding: 10px 12px; border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.35); font: 13px/1.4 system-ui, -apple-system, sans-serif;
  }
  #qa-autoflow-editor .qa-edit-sel { color:#9ca3af; font-size:11px; word-break:break-all; margin-bottom:6px; max-height: 40px; overflow: hidden; }
  #qa-autoflow-editor .qa-edit-input { width:100%; padding:7px 9px; border-radius:5px; border:1px solid #374151; background:#1f2937; color:#fff; font:13px system-ui; box-sizing: border-box; }
  #qa-autoflow-editor .qa-edit-input:focus { outline: 2px solid #10b981; border-color: transparent; }
  #qa-autoflow-editor .qa-edit-actions { display:flex; gap:6px; margin-top:8px; }
  #qa-autoflow-editor .qa-edit-actions button { padding:5px 10px; border:0; border-radius:5px; cursor:pointer; font:12px system-ui; font-weight:500; }
  #qa-autoflow-editor .qa-edit-save { background:#10b981; color:#fff; flex:1; }
  #qa-autoflow-editor .qa-edit-skip { background:#374151; color:#fff; }
  #qa-autoflow-overlay {
    position: fixed; inset: 0; pointer-events: none; z-index: 2147483640;
    box-shadow: inset 0 0 0 5px #10b981;
    animation: qa-autoflow-pulse 2s ease-in-out infinite;
  }
  @keyframes qa-autoflow-pulse {
    0%, 100% { box-shadow: inset 0 0 0 5px #10b981; }
    50%      { box-shadow: inset 0 0 0 5px #34d399; }
  }
  #qa-autoflow-close {
    position: fixed; top: 14px; right: 14px; z-index: 2147483647;
    background: #ef4444; color: #fff; border: 0; padding: 9px 14px;
    border-radius: 8px; font: 600 13px/1 system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,0.3); pointer-events: auto;
  }
  #qa-autoflow-close:hover { background: #dc2626; }
`;
document.head.appendChild(style);

// Normalize raw event target → the element we actually want to save/highlight.
function normalizeTarget(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return el;

  // SVG icons inside dropdown arrows etc. → climb to the interactive ancestor.
  if (el.tagName === 'svg' || el.tagName === 'path' || el.tagName === 'SVG' || el.tagName === 'PATH') {
    el = el.closest(INTERACTIVE_SELECTOR) || el.closest(DROPDOWN_HINT_SELECTOR) || el.parentElement || el;
  }

  // Prefer the nearest interactive ancestor (covers hovering label text, ::before circle, wrapping div).
  const interactive = el.closest(INTERACTIVE_SELECTOR);
  if (interactive) {
    // For label[for=X] resolve to the underlying input — so radio/checkbox always saves the input.
    if (interactive.tagName === 'LABEL' && interactive.htmlFor) {
      const linked = document.getElementById(interactive.htmlFor);
      if (linked) return linked;
    }
    return interactive;
  }

  // Hidden native <select> overlay pattern: sites style a <div> and put an invisible
  // (opacity:0) <select> on top of it. Clicks land on the wrapper, but the real element
  // we want to fill is the inner <select>. If the click target contains exactly one
  // descendant <select>, capture that instead.
  if (el.querySelectorAll) {
    const innerSelects = el.querySelectorAll('select');
    if (innerSelects.length === 1) return innerSelects[0];
  }

  // No interactive ancestor — likely a custom dropdown wrapper.
  return el.closest(DROPDOWN_HINT_SELECTOR) || el;
}

// Visual element used for highlight feedback. For radios/checkboxes we want the cohesive
// "field group" wrapper (the dot + label together), not just the label or just the input —
// that way hover doesn't jump between sub-parts.
function visualFor(el) {
  if (!el) return el;
  if (el.type === 'radio' || el.type === 'checkbox') {
    const wrapper = el.closest(
      '.custom-radio, .custom-checkbox, .custom-control, .form-check, .radio, .checkbox, ' +
      '[class*="-radio" i], [class*="-checkbox" i], [class*="form-check" i]'
    );
    if (wrapper) return wrapper;
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) return wrappingLabel;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) return lbl.parentElement || lbl;
    }
  }
  return el;
}

function showBanner(text, variant) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'qa-autoflow-banner';
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = text;
  bannerEl.className = variant ? `qa-${variant}` : '';
  bannerEl.style.display = 'block';
}

function hideBanner() {
  if (bannerEl) bannerEl.style.display = 'none';
}

function clearPendingDropdown() {
  if (pendingDropdown && pendingDropdown.triggerEl) {
    pendingDropdown.triggerEl.classList.remove('qa-autoflow-pending');
  }
  pendingDropdown = null;
}

// Detect a date/calendar field by type or naming hints. Such fields open a custom
// calendar widget on click — we don't want to overlay our inline editor on top.
function isDateField(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  const type = (el.type || '').toLowerCase();
  if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'week') return true;
  const hints = [
    el.id, el.name, el.placeholder, el.getAttribute('aria-label'),
    el.className, el.getAttribute('autocomplete')
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(date|calendar|birth|dob|datepicker)\b/.test(hints);
}

function clearPendingDate() {
  if (pendingDate) {
    clearInterval(pendingDate.interval);
    clearTimeout(pendingDate.timeout);
    if (pendingDate.input) pendingDate.input.classList.remove('qa-autoflow-pending');
    pendingDate = null;
  }
}

function startDateCapture(input, selector) {
  clearPendingDate();
  const initialValue = input.value || '';
  input.classList.add('qa-autoflow-pending');
  showBanner('Pick a date from the calendar — it will be saved automatically.', 'warn');

  pendingDate = {
    input, selector, initialValue,
    interval: setInterval(() => {
      if (!pendingDate) return;
      const v = pendingDate.input.value || '';
      if (v && v !== pendingDate.initialValue) {
        const saved = v;
        const inp = pendingDate.input;
        const sel = pendingDate.selector;
        clearPendingDate();
        saveToProfile(activeProfileId, sel, saved, inp);
        inp.classList.add('qa-autoflow-picked');
        capturedThisSession++;
        showBanner(`Captured #${capturedThisSession}: "${saved}". Pick another or Stop Picker to finish.`, 'ok');
      }
    }, 150),
    timeout: setTimeout(() => {
      if (pendingDate) {
        showBanner('Date capture timed out — try again or click another field.', 'warn');
        clearPendingDate();
      }
    }, 30000)
  };
}

function mountOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'qa-autoflow-overlay';
  document.body.appendChild(overlayEl);

  closeBtnEl = document.createElement('button');
  closeBtnEl.id = 'qa-autoflow-close';
  closeBtnEl.type = 'button';
  closeBtnEl.textContent = '✕ Stop Picker';
  closeBtnEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopPicker();
  });
  closeBtnEl.addEventListener('mousedown', (e) => e.stopPropagation(), true);
  document.body.appendChild(closeBtnEl);
}

function unmountOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  if (closeBtnEl) { closeBtnEl.remove(); closeBtnEl = null; }
}

function stopPicker() {
  if (!isPicking) return;
  const captured = capturedThisSession;
  const profileForRun = activeProfileId;
  isPicking = false;
  closeInlineEditor();
  clearPendingDropdown();
  clearPendingDate();
  if (hoveredElement) hoveredElement.classList.remove('qa-autoflow-hover');
  document.querySelectorAll('.qa-autoflow-picked').forEach(el => el.classList.remove('qa-autoflow-picked'));
  document.querySelectorAll('.qa-autoflow-pending').forEach(el => el.classList.remove('qa-autoflow-pending'));
  unmountOverlay();

  if (captured > 0) {
    showBanner(`Picker stopped — ${captured} field(s) saved. Press Alt+F to auto-fill.`, 'ok');
  } else {
    showBanner('Picker stopped.', 'ok');
  }
  setTimeout(hideBanner, 2000);
}

// Read label/placeholder/aria/name/id/type → pick a sensible default test value.
function inferValue(el) {
  if (!el) return 'Test';
  const type = (el.type || '').toLowerCase();
  let labelText = '';
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl) labelText = lbl.textContent;
  }
  if (!labelText) {
    const wrap = el.closest('label');
    if (wrap) labelText = wrap.textContent;
  }
  const hints = [
    el.placeholder, el.getAttribute('aria-label'), el.getAttribute('aria-labelledby'),
    el.name, el.id, labelText
  ].filter(Boolean).join(' ').toLowerCase();

  if (type === 'email' || /e[\s-]?mail/.test(hints)) return '{{RANDOM_EMAIL}}';
  if (type === 'tel' || /\b(phone|mobile|tel|gsm|cell)\b/.test(hints)) return '{{RANDOM_NUM}}';
  if (type === 'date' || /\b(date|birth|dob|doğum|tarix)\b/.test(hints)) return '{{TODAY}}';
  if (type === 'password' || /password|şifr[əe]|parol/.test(hints)) return 'Test1234!';
  if (type === 'url' || /\b(url|website|site|link)\b/.test(hints)) return 'https://example.com';
  if (type === 'number' || /\b(age|yaş|amount|price|sum|qty|quantity|count)\b/.test(hints)) {
    if (/\bage|yaş\b/.test(hints)) return '25';
    return '100';
  }
  if (/first.*name|given|ad\b|name.*first/.test(hints)) return 'Test';
  if (/last.*name|surname|family|soyad/.test(hints)) return 'User';
  if (/full.*name|^name\b|tam.*ad/.test(hints)) return 'Test User';
  if (/company|organization|şirkət/.test(hints)) return 'Test Co';
  if (/address|street|ünvan/.test(hints)) return 'Test Street 123';
  if (/\bcity|şəhər/.test(hints)) return 'Baku';
  if (/state|region|vilayət/.test(hints)) return 'Test State';
  if (/\bzip|postal|poçt/.test(hints)) return '1000';
  if (/country|ölkə/.test(hints)) return 'Azerbaijan';
  if (/subject|topic|mövzu/.test(hints)) return 'Test';
  if (/message|comment|note|description|açıklama|qeyd/.test(hints)) return 'Test message';
  if (/card.*number|kart.*nömrə/.test(hints)) return '4111111111111111';
  if (/cvv|cvc/.test(hints)) return '123';
  return 'Test';
}

function closeInlineEditor() {
  if (editorEl) { editorEl.remove(); editorEl = null; }
  editorCommit = null;
  editorCancel = null;
}

function positionEditor(card, target) {
  const rect = target.getBoundingClientRect();
  const cardW = 320;
  const cardH = 130; // rough
  let top = window.scrollY + rect.bottom + 8;
  let left = window.scrollX + rect.left;
  // Flip above if not enough space below
  if (rect.bottom + cardH > window.innerHeight && rect.top > cardH) {
    top = window.scrollY + rect.top - cardH - 8;
  }
  if (left + cardW > window.scrollX + window.innerWidth) {
    left = window.scrollX + window.innerWidth - cardW - 12;
  }
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  card.style.top = top + 'px';
  card.style.left = left + 'px';
}

let editorCommit = null; // exposed so document-level keydown can call commit regardless of focus
let editorCancel = null;

function openInlineEditor(target, selector, suggestedValue, onSave) {
  closeInlineEditor();
  const card = document.createElement('div');
  card.id = 'qa-autoflow-editor';
  card.innerHTML = `
    <div class="qa-edit-sel"></div>
    <input class="qa-edit-input" type="text" />
    <div class="qa-edit-actions">
      <button class="qa-edit-save" type="button">Save · Enter</button>
      <button class="qa-edit-skip" type="button">Skip · Esc</button>
    </div>
  `;
  card.querySelector('.qa-edit-sel').textContent = selector;
  const input = card.querySelector('.qa-edit-input');
  input.value = suggestedValue || '';
  document.body.appendChild(card);
  positionEditor(card, target);

  // Aggressive focus — the page's own input may have grabbed focus on mousedown
  // before we got here; steal it back, with one RAF retry for safety.
  const grabFocus = () => { try { input.focus({ preventScroll: true }); input.select(); } catch {} };
  grabFocus();
  requestAnimationFrame(grabFocus);

  editorCommit = () => {
    const v = input.value;
    closeInlineEditor();
    if (v && v.trim() !== '') onSave(v);
  };
  editorCancel = () => closeInlineEditor();

  card.querySelector('.qa-edit-save').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    editorCommit && editorCommit();
  });
  card.querySelector('.qa-edit-skip').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    editorCancel && editorCancel();
  });

  editorEl = card;
}

// --- 1. MESSAGE LISTENER (unified) ---

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "startPicker") {
    isPicking = true;
    activeProfileId = request.profileId;
    capturedThisSession = 0;
    undoStack = [];
    closeInlineEditor();
    clearPendingDropdown();
    chrome.storage.local.get(['qaProfiles'], (result) => {
      activeProfileFields = result.qaProfiles?.[activeProfileId]?.fields || [];
    });
    mountOverlay();
    showBanner("Picker active — click fields. Shift+Click for div-buttons. X Stop Picker to finish.");
    relayToChildFrames('startPicker', request.profileId);
  } else if (request.action === "runAutoFill") {
    lastObserverFireAt = Date.now(); // suppress observer for the cooldown window
    runExecutionEngine(request.profileId);
    relayToChildFrames('runAutoFill', request.profileId);
  }
});

document.addEventListener('mouseover', (e) => {
  if (!isPicking) return;
  if (editorEl && editorEl.contains(e.target)) return;
  if (bannerEl && bannerEl.contains(e.target)) return;
  if (closeBtnEl && closeBtnEl.contains(e.target)) return;
  if (overlayEl && overlayEl.contains(e.target)) return;
  let normalized = normalizeTarget(e.target);
  let promotedFromDropdown = false;

  // Try dropdown promotion — only for clicks that land in a single-combobox subtree.
  const dropdown = findDropdownContainer(e.target);
  if (dropdown && !looksLikeMenuInternal(dropdown)) {
    const role = normalized.getAttribute && normalized.getAttribute('role');
    const isRealFormField =
      (normalized.tagName === 'INPUT' && role !== 'combobox' &&
        !['radio', 'checkbox'].includes((normalized.type || '').toLowerCase())) ||
      normalized.tagName === 'TEXTAREA' ||
      normalized.tagName === 'SELECT';
    if (!isRealFormField) {
      normalized = dropdown;
      promotedFromDropdown = true;
    }
  }

  // Only highlight recognized form elements, promoted dropdowns, or anything the user
  // can clearly click on (cursor:pointer). This catches div-buttons / tab-buttons while
  // still ignoring layout wrappers (cursor:default), big background divs, etc.
  const tag = normalized.tagName;
  const type = (normalized.type || '').toLowerCase();
  const isFormField =
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' ||
    type === 'radio' || type === 'checkbox';
  let isPointerClickable = false;
  if (!isFormField && !promotedFromDropdown) {
    try {
      if (getComputedStyle(normalized).cursor === 'pointer') {
        const rect = normalized.getBoundingClientRect();
        // Reject huge containers (likely a wrapper that just inherits cursor:pointer).
        if (rect.width < window.innerWidth * 0.6 && rect.height < window.innerHeight * 0.5) {
          isPointerClickable = true;
        }
      }
    } catch {}
  }
  const isField = promotedFromDropdown || isFormField || isPointerClickable;

  if (!isField) {
    if (hoveredElement) {
      hoveredElement.classList.remove('qa-autoflow-hover');
      hoveredElement = null;
    }
    return;
  }

  const target = visualFor(normalized);
  if (!target || target === bannerEl || target === editorEl) return;
  if (target.classList && target.classList.contains('qa-autoflow-picked')) return;

  if (hoveredElement && hoveredElement !== target) hoveredElement.classList.remove('qa-autoflow-hover');
  hoveredElement = target;
  hoveredElement.classList.add('qa-autoflow-hover');
});

// Step 2 of two-step dropdown capture runs in MOUSEDOWN capture phase.
// react-select & similar libraries act on mousedown (not click) — by the time the
// click event fires, the option element is often already gone from the DOM.
document.addEventListener('mousedown', (e) => {
  if (!isPicking || !pendingDropdown) return;
  if (bannerEl && bannerEl.contains(e.target)) return;
  if (editorEl && editorEl.contains(e.target)) return;
  if (overlayEl && overlayEl.contains(e.target)) return;
  if (closeBtnEl && closeBtnEl.contains(e.target)) return;
  // NOTE: do NOT skip when e.target is inside triggerEl — for react-select etc. the
  // option menu is rendered as a descendant of the trigger container, so descendants
  // ARE the options we want to capture. Only skip if it's exactly the trigger itself.
  if (e.target === pendingDropdown.triggerEl) return;

  const optionText = (e.target.textContent || '').trim().replace(/\s+/g, ' ');
  if (optionText && optionText.length > 0 && optionText.length < 120) {
    saveToProfile(activeProfileId, pendingDropdown.selector, optionText, pendingDropdown.triggerEl);
    pendingDropdown.triggerEl.classList.remove('qa-autoflow-pending');
    pendingDropdown.triggerEl.classList.add('qa-autoflow-picked');
    capturedThisSession++;
    recentDropdownCaptureAt = Date.now();
    showBanner(`Captured #${capturedThisSession}: "${optionText}". Pick another or ESC to finish.`, 'ok');
  } else {
    showBanner('Could not read option text — try again.', 'warn');
  }
  pendingDropdown = null;
  // No preventDefault — let the library finish selecting the option.
}, true);

// CLICK HANDLING
document.addEventListener('click', (e) => {
  if (!isPicking) return;

  // Ignore clicks on our own UI.
  if (bannerEl && bannerEl.contains(e.target)) return;
  if (editorEl && editorEl.contains(e.target)) return;
  if (closeBtnEl && closeBtnEl.contains(e.target)) return;
  if (overlayEl && overlayEl.contains(e.target)) return;

  // While the inline editor is open, swallow all page clicks so the picker doesn't advance.
  if (editorEl) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Suppress the trailing click that immediately follows a mousedown-based dropdown capture.
  if (Date.now() - recentDropdownCaptureAt < 400) {
    return;
  }

  let target = normalizeTarget(e.target);

  // If the click landed inside a custom dropdown (react-select etc.) but normalizeTarget
  // returned an inner div, climb up to the dropdown container that hosts the combobox.
  if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT' &&
      target.type !== 'radio' && target.type !== 'checkbox') {
    const dropdown = findDropdownContainer(e.target);
    if (dropdown && dropdown !== target && !looksLikeMenuInternal(dropdown)) {
      target = dropdown;
    }
  }

  const tagName = target.tagName;

  // Real radio / checkbox / native <select> → let the change listener handle it.
  if (tagName === 'SELECT' || target.type === 'radio' || target.type === 'checkbox') {
    if (hoveredElement) hoveredElement.classList.remove('qa-autoflow-hover');
    return;
  }

  if (hoveredElement) hoveredElement.classList.remove('qa-autoflow-hover');

  const selector = generateOptimalSelector(target);
  const existingField = activeProfileFields.find(f => f.selector === selector);
  const defaultValue = existingField ? existingField.value : inferValue(target);

  // Action button (button, input type=submit/button/reset, [role=button]) → save as a
  // click-only capture. On autofill we just re-click it; no value needed.
  const role = target.getAttribute && target.getAttribute('role');
  const inputType = (target.type || '').toLowerCase();
  const isActionButton =
    tagName === 'BUTTON' ||
    (tagName === 'INPUT' && (inputType === 'submit' || inputType === 'button' || inputType === 'reset')) ||
    role === 'button';
  if (isActionButton) {
    e.preventDefault();
    e.stopPropagation();
    saveToProfile(activeProfileId, selector, 'CLICK', target);
    target.classList.add('qa-autoflow-picked');
    capturedThisSession++;
    showBanner(`Captured #${capturedThisSession}: button click. Pick another or Stop Picker to finish.`, 'ok');
    return;
  }

  if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
    // Date/calendar input → don't open editor; let the calendar widget open and
    // watch the input value to save whatever the user picks.
    if (tagName === 'INPUT' && isDateField(target)) {
      startDateCapture(target, selector);
      return; // no preventDefault — let the calendar open naturally
    }
    e.preventDefault();
    e.stopPropagation();
    // Resolve tokens (e.g. {{RANDOM_NUM}}) to concrete values for the suggestion the user sees.
    // The user can still type the token manually if they want a dynamic value at runtime.
    const initialValue = defaultValue && /\{\{[A-Z_]+\}\}/.test(defaultValue)
      ? parseDynamicVariables(defaultValue)
      : defaultValue;
    openInlineEditor(target, selector, initialValue, (value) => {
      saveToProfile(activeProfileId, selector, value, target);
      target.classList.add('qa-autoflow-picked');
      capturedThisSession++;
      // Immediately reflect the value in the real page input so the user sees feedback.
      try { applyValueToElement(target, parseDynamicVariables(value)); } catch (err) {}
      showBanner(`Captured #${capturedThisSession}. Pick another or ESC to finish.`, 'ok');
    });
    return;
  }

  // --- Step 1 of two-step dropdown capture ---
  // Guard 1: reject obvious menu/listbox internals — those disappear when the menu
  // closes, so saving them as a trigger selector breaks future autofill.
  if (looksLikeMenuInternal(target)) {
    showBanner('That looks like an open menu — close it, then click the dropdown trigger itself.', 'warn');
    return;
  }
  // Guard 2: only treat the click as a dropdown trigger if the element looks clickable.
  if (!looksClickable(target)) {
    showBanner('That element isn\'t a recognized field — click an input, radio, checkbox, or dropdown.', 'warn');
    return;
  }
  // Shift+Click → force "save as CLICK action", skip the dropdown two-step flow.
  // Useful for div-buttons that have cursor:pointer but no menu (custom buttons
  // rendered as <div> instead of <button>).
  if (e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    saveToProfile(activeProfileId, selector, 'CLICK', target);
    target.classList.add('qa-autoflow-picked');
    capturedThisSession++;
    showBanner(`Captured #${capturedThisSession}: button action (Shift+Click). Pick another or Stop Picker to finish.`, 'ok');
    return;
  }

  pendingDropdown = { selector, triggerEl: target };
  target.classList.add('qa-autoflow-pending');
  showBanner('Dropdown opened — now click the option you want. ESC to cancel.', 'warn');
  // No preventDefault → site opens its dropdown.
}, true);

// Walk up from the click target looking for a container that hosts a role="combobox"
// (react-select, downshift, headlessui, etc. all expose this). The combobox container is
// the stable, re-findable trigger we want to save as the selector.
function findDropdownContainer(el) {
  if (!el) return null;
  const comboSelector = '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]';

  // Step 1: climb to find the nearest ancestor that contains EXACTLY ONE combobox.
  let candidate = null;
  let cur = el;
  for (let i = 0; i < 6 && cur && cur.nodeType === Node.ELEMENT_NODE; i++, cur = cur.parentElement) {
    if (!cur.querySelectorAll) continue;
    const combos = cur.querySelectorAll(comboSelector);
    if (combos.length === 0) continue;
    if (combos.length > 1) break;
    candidate = cur;
    break;
  }
  if (!candidate) return null;

  // Proximity check: the click target must be part of the dropdown widget itself,
  // not a sibling element living next to it. We require el to be within the
  // combobox's immediate wrapper (parent or grandparent). Without this, pages that
  // have an address autocomplete inside a card would mistakenly promote tabs,
  // buttons, and even the map as if they were the dropdown.
  const combo = candidate.querySelector(comboSelector);
  if (combo && combo !== el && !combo.contains(el)) {
    const parent = combo.parentElement;
    const grandparent = parent && parent.parentElement;
    const insideWidget = (parent && parent.contains(el)) || (grandparent && grandparent.contains(el));
    if (!insideWidget) return null;
  }

  // Step 2: prefer an ancestor with a stable id (e.g. <div id="state">) within 3
  // levels up — but stop if that ancestor would also contain a second dropdown.
  let probe = candidate;
  for (let i = 0; i < 3 && probe; i++, probe = probe.parentElement) {
    if (!probe.querySelectorAll) break;
    if (probe.querySelectorAll(comboSelector).length > 1) break;
    if (probe.id && !looksLikeMenuInternal(probe)) return probe;
  }
  return candidate;
}

// Given a saved dropdown trigger (possibly an outer container), return the inner element
// to actually dispatch click events on. For react-select etc., dispatching on the outer
// container does NOT propagate to child control handlers (events bubble up, not down).
function pickClickTarget(el) {
  if (!el || !el.querySelector) return el;
  const combobox = el.querySelector('[role="combobox"]');
  if (combobox) return combobox;
  const haspopup = el.querySelector('[aria-haspopup]');
  if (haspopup) return haspopup;
  return el;
}

// Reject menu/listbox/popup internals — these elements only exist while a dropdown is open
// and saving them as a "trigger" selector means autofill can never find them later.
function looksLikeMenuInternal(el) {
  if (!el || !el.tagName) return false;
  const role = el.getAttribute && el.getAttribute('role');
  if (role && /^(listbox|menu|option|menuitem|tree|grid)$/.test(role)) return true;
  const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
  if (/\b(listbox|menu-list|menulist|popup|portal|overlay|backdrop|tooltip)\b/.test(cls)) return true;
  if (/-menu$|-listbox$|-option$|-popup$/.test(cls)) return true;
  const id = (el.id || '').toLowerCase();
  if (/-listbox$|-menu$|-popup$/.test(id)) return true;
  // Also walk up: if any ancestor within 3 levels is a listbox, this is likely an option row.
  let cur = el.parentElement;
  for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
    const r = cur.getAttribute && cur.getAttribute('role');
    if (r === 'listbox' || r === 'menu') return true;
    const cid = (cur.id || '').toLowerCase();
    if (/-listbox$|-menu$/.test(cid)) return true;
  }
  return false;
}

function looksClickable(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  // Hard reject: page-level layout containers — clicking these is almost always accidental.
  if (tag === 'FORM' || tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'SECTION' ||
      tag === 'ARTICLE' || tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') {
    return false;
  }
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;

  const role = el.getAttribute && el.getAttribute('role');
  if (role && /^(button|combobox|listbox|menuitem|option|tab|switch)$/.test(role)) return true;

  const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
  // Common library class hints (react-select uses "-control", "-value-container", etc.)
  if (/select|dropdown|combobox|control|trigger|chooser|picker|menu|toggle|indicator/.test(cls)) return true;

  try {
    const cursor = getComputedStyle(el).cursor;
    if (cursor === 'pointer') return true;
  } catch {}

  // Size heuristic: if the element is not huge (less than 75% viewport width AND 60% viewport height)
  // and it has either a child SVG or no children, treat it as a small interactive thing.
  try {
    const rect = el.getBoundingClientRect();
    const tooBig = rect.width > window.innerWidth * 0.75 || rect.height > window.innerHeight * 0.6;
    if (!tooBig) {
      if (el.querySelector('svg')) return true; // dropdowns typically have a caret SVG
      if (el.children.length === 0) return true; // leaf node
    }
  } catch {}

  return false;
}

// CHANGE LISTENER (for labels and native elements)
document.addEventListener('change', (e) => {
  if (!isPicking) return;
  const target = normalizeTarget(e.target);
  const tagName = target.tagName;
  const type = target.type;

  if (tagName === 'SELECT' || type === 'radio' || type === 'checkbox') {
    const selector = generateOptimalSelector(target);
    let value = "";
    let visualElement = visualFor(target);

    if (type === 'radio') {
      value = "true";
      if (target.name) {
        document.querySelectorAll(`input[type="radio"][name="${target.name}"]`).forEach(radio => {
          let rVis = radio;
          if (radio.id) {
            const l = document.querySelector(`label[for="${radio.id}"]`);
            if (l) rVis = l;
          }
          rVis.classList.remove('qa-autoflow-picked');
        });
      }
    } else if (type === 'checkbox') {
      value = target.checked ? "true" : "false";
      if (!target.checked) visualElement.classList.remove('qa-autoflow-picked');
    } else if (tagName === 'SELECT') {
      value = target.value;
    }

    saveToProfile(activeProfileId, selector, value, target);
    if (value === "true" || tagName === 'SELECT') {
      visualElement.classList.add('qa-autoflow-picked');
      capturedThisSession++;
      showBanner(`Captured #${capturedThisSession}. Pick another or ESC to finish.`, 'ok');
    }
  }
}, true);

// Capture-phase keydown so we win against the page (some sites swallow Enter on inputs).
document.addEventListener('keydown', (e) => {
  if (!isPicking) return;

  // Ctrl/Cmd+Z while in picker → undo last capture (but not while editor is open).
  if (!editorEl && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.stopPropagation();
    undoLastCapture();
    return;
  }

  // Inline editor open → handle Enter / Escape regardless of where focus ended up.
  if (editorEl) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      editorCommit && editorCommit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      editorCancel && editorCancel();
      return;
    }
    return; // let other keys (typing) reach the input naturally
  }

  if (e.key !== "Escape") return;

  // Dropdown awaiting option → cancel just that step.
  if (pendingDropdown) {
    clearPendingDropdown();
    showBanner('Dropdown capture cancelled — pick another element or ESC again to finish.', 'warn');
    return;
  }

  // Date picker waiting for selection → cancel.
  if (pendingDate) {
    clearPendingDate();
    showBanner('Date capture cancelled — pick another element or ESC again to finish.', 'warn');
    return;
  }

  // Exit picker via ESC.
  stopPicker();
}, true);

// --- 2. HELPERS ---

// Try a candidate selector — return it only if it resolves to exactly one element.
function tryUniqueSelector(candidate) {
  try {
    return document.querySelectorAll(candidate).length === 1 ? candidate : null;
  } catch { return null; }
}

function cssEscape(s) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\#.>+~()[\]:])/g, '\\$1');
}

function generateOptimalSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  if (el.id) return `#${cssEscape(el.id)}`;

  const tag = el.tagName.toLowerCase();
  if (el.name) {
    const hit = tryUniqueSelector(`${tag}[name="${cssEscape(el.name)}"]`);
    if (hit) return hit;
  }

  // For form-relevant tags, try discriminating attributes that React often provides.
  const attrs = ['data-testid', 'data-test', 'data-id', 'data-qa', 'data-cy', 'aria-label', 'placeholder'];
  for (const a of attrs) {
    const v = el.getAttribute && el.getAttribute(a);
    if (!v) continue;
    const hit = tryUniqueSelector(`${tag}[${a}="${cssEscape(v)}"]`);
    if (hit) return hit;
  }

  // Type / required / role-based heuristics — useful for unmarked native selects, etc.
  if (tag === 'select') {
    if (el.required) {
      const hit = tryUniqueSelector(`select[required]`);
      if (hit) return hit;
    }
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'button') {
    if (el.type) {
      const hit = tryUniqueSelector(`${tag}[type="${cssEscape(el.type)}"]`);
      if (hit) return hit;
    }
  }

  // Try unique class — but only individual stable-looking classes (skip hashed CSS-in-JS).
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(c =>
      c && c.length < 50 && !/^css-[a-z0-9]{4,}/i.test(c) && !/\d{4,}/.test(c)
    );
    for (const cls of classes) {
      const hit = tryUniqueSelector(`${tag}.${cssEscape(cls)}`);
      if (hit) return hit;
    }
    if (classes.length > 1) {
      const combined = `${tag}${classes.map(c => '.' + cssEscape(c)).join('')}`;
      const hit = tryUniqueSelector(combined);
      if (hit) return hit;
    }
  }

  // Fallback: anchor at the closest ancestor with an id and walk back down.
  // Shorter paths are less fragile than full nth-of-type chains.
  let path = [];
  let currentEl = el;
  while (currentEl.nodeType === Node.ELEMENT_NODE && currentEl.tagName !== 'HTML') {
    let selector = currentEl.nodeName.toLowerCase();
    if (currentEl.id) {
      selector += `#${cssEscape(currentEl.id)}`;
      path.unshift(selector);
      break;
    } else {
      let sib = currentEl, nth = 1;
      while (sib = sib.previousElementSibling) { if (sib.nodeName.toLowerCase() == selector) nth++; }
      if (nth != 1) selector += `:nth-of-type(${nth})`;
    }
    path.unshift(selector);
    currentEl = currentEl.parentNode;
  }
  return path.join(" > ");
}

function saveToProfile(profileId, selector, value, element) {
  chrome.storage.local.get(['qaProfiles'], (result) => {
    let profiles = result.qaProfiles || {};
    if (profiles[profileId]) {

      // Remove duplicate radio-group entries from the dashboard
      if (element.type === 'radio' && element.name) {
        const allRadiosInGroup = document.querySelectorAll(`input[type="radio"][name="${element.name}"]`);
        const allSelectorsInGroup = Array.from(allRadiosInGroup).map(r => generateOptimalSelector(r));
        profiles[profileId].fields = profiles[profileId].fields.filter(f => !allSelectorsInGroup.includes(f.selector));
      }

      // Page-grouping metadata. We use pathname + hash (ignore query/host) so the
      // same wizard step matches even if tracking params change. pageTitle gives a
      // human-readable label for the dashboard section header.
      const pageKey = (window.location.pathname || '/') + (window.location.hash || '');
      const pageTitle = (document.title || '').trim().slice(0, 100);

      // Match by selector + pageKey — same selector on a different page is a
      // separate field (sites sometimes reuse generic selectors like #email across
      // wizard steps). Within the SAME page, re-capturing updates the value.
      const existingIndex = profiles[profileId].fields.findIndex(f =>
        f.selector === selector && (f.pageKey || '') === pageKey
      );
      const previousValue = existingIndex > -1 ? profiles[profileId].fields[existingIndex].value : null;

      if (existingIndex > -1) {
        profiles[profileId].fields[existingIndex].value = value;
      } else {
        profiles[profileId].fields.push({
          selector: selector,
          value: value,
          pageKey,
          pageTitle
        });
      }

      // Push to undo stack so Ctrl/Cmd+Z can revert this capture during the session.
      if (isPicking) {
        undoStack.push({ selector, previousValue, element, wasNew: existingIndex === -1 });
      }

      activeProfileFields = profiles[profileId].fields;
      chrome.storage.local.set({ qaProfiles: profiles });
    }
  });
}

// Revert the last capture made in this picker session.
function undoLastCapture() {
  if (!undoStack.length) {
    showBanner('Nothing to undo.', 'warn');
    return;
  }
  const last = undoStack.pop();
  chrome.storage.local.get(['qaProfiles'], (result) => {
    const profiles = result.qaProfiles || {};
    const profile = profiles[activeProfileId];
    if (!profile) return;
    const idx = profile.fields.findIndex(f => f.selector === last.selector);
    if (idx > -1) {
      if (last.wasNew) {
        profile.fields.splice(idx, 1);
      } else {
        profile.fields[idx].value = last.previousValue;
      }
      activeProfileFields = profile.fields;
      chrome.storage.local.set({ qaProfiles: profiles });
    }
    if (last.element) last.element.classList.remove('qa-autoflow-picked');
    capturedThisSession = Math.max(0, capturedThisSession - 1);
    showBanner(`Undone "${last.selector}". ${capturedThisSession} captured this session.`, 'warn');
  });
}

// --- 3. SMART EXECUTION ENGINE (AUTO-FILL) ---

// Is the element actually visible to the user (not hidden, not detached, not on an
// inactive tab)? Multi-tab wizards keep the other tab's DOM but make it invisible.
// We must skip hidden elements — writing into them either silently fails or, worse,
// triggers form validation for the wrong tab.
function isElementVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'BODY' || el.tagName === 'HTML') return true;
  // offsetParent === null catches display:none and detached subtrees (except <body>).
  if (el.offsetParent === null) {
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch {}
    // Fallback: zero-size box → invisible.
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  }
  // Walk a few ancestors for visibility=hidden / display:none that JS can't always see
  // via offsetParent (e.g. position:fixed elements inside a hidden tab).
  let p = el;
  for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
    try {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
        // opacity:0 is sometimes used intentionally (overlaid native selects), so only
        // reject when combined with zero-size box.
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
      }
    } catch {}
  }
  return true;
}

// Heuristic — does this element look like a form-submit button (the kind that should
// fire LAST, after all fields are filled, and only when the user has explicitly enabled
// "Click buttons" in the popup)? Other button-like elements (currency toggles, custom
// radio divs) are NOT submit-like and always run in their DOM position.
function isSubmitLikeButton(el) {
  if (!el) return false;
  const tag = el.tagName;
  const type = (el.type || '').toLowerCase();
  if (tag === 'INPUT' && (type === 'submit' || type === 'reset')) return true;
  if (tag === 'BUTTON') {
    if (type === 'submit' || type === 'reset') return true;
    const txt = (el.textContent || '').trim().toLowerCase();
    return /\b(submit|continue|next|davam|göndər|tamam|təsdiq|finish|done|send|apply|sifariş|təsdiqlə|ok)\b/i.test(txt);
  }
  return false;
}

async function runExecutionEngine(explicitProfileId, opts) {
  opts = opts || {};
  const fromObserver = !!opts.fromObserver;

  // Concurrency guard — if a run is already in progress, do nothing.
  if (isAutofilling) {
    if (!fromObserver) showBanner('AutoFill already running — please wait.', 'warn');
    return;
  }
  isAutofilling = true;

  try {
    const result = await chrome.storage.local.get(['qaProfiles', 'activeRunProfile', 'settings']);
    const profileId = explicitProfileId || result.activeRunProfile;
    const profiles = result.qaProfiles;
    const settings = result.settings || {};
    if (!profileId || !profiles || !profiles[profileId]) {
      if (!fromObserver) {
        showBanner('No active profile — open the popup and select one.', 'warn');
      }
      return;
    }
    const allFields = profiles[profileId].fields || [];
    if (!allFields.length) {
      if (!fromObserver) showBanner('Active profile has no saved fields yet.', 'warn');
      return;
    }

    // Restrict to fields captured on THIS URL. Legacy fields without pageKey are
    // still included for backward compat. Anything saved on another step is
    // skipped entirely — we don't waste time waiting for elements that belong to
    // a different page.
    const currentPageKey = (window.location.pathname || '/') + (window.location.hash || '');
    const pageFields = allFields.filter(f => !f.pageKey || f.pageKey === currentPageKey);
    if (!pageFields.length) {
      if (!fromObserver) showBanner(`AutoFill: no fields saved for this URL (${allFields.length} saved for other pages).`, 'warn');
      return;
    }
    const totalFields = pageFields.length;

  // Manual triggers (Alt+F, popup, initial page-load): clear stale tags so all fields
  // refill. Observer-triggered runs keep tags so already-handled fields/buttons are skipped.
  if (!fromObserver) {
    document.querySelectorAll('[data-qa-autofilled-key]').forEach(el => {
      try { delete el.dataset.qaAutofilledKey; } catch {}
    });
  }

  // Quick parallel pre-resolve — short timeout. We only need this to determine the
  // initial DOM order of fields that already exist. Anything not present yet (e.g. a
  // select that will only render after a preceding tab click) stays null here and gets
  // re-resolved just-in-time inside the loop, with a longer wait, AFTER the preceding
  // action has had a chance to inject it.
  const resolved = await Promise.all(pageFields.map(async f => ({
    field: f,
    element: await waitForElement(f.selector, 300)
  })));

  const buildItem = (field, element) => {
    const value = parseDynamicVariables(field.value);
    const tag = element.tagName;
    const type = (element.type || '').toLowerCase();
    const role = element.getAttribute && element.getAttribute('role');
    const isClickTarget =
      (typeof value === 'string' && value.toUpperCase() === 'CLICK') ||
      tag === 'BUTTON' ||
      (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) ||
      role === 'button';
    return {
      field, element,
      value: isClickTarget ? 'CLICK' : value,
      isClickTarget,
      isSubmitLike: isSubmitLikeButton(element)
    };
  };

  // Include EVERY field — those without an element yet get a placeholder so the loop
  // can retry them in capture order after preceding actions complete.
  const items = resolved.map(({ field, element }, idx) => {
    const base = element ? buildItem(field, element) : { field, element: null, value: null, pending: true };
    base.captureOrder = idx;
    return base;
  });

  // Pure capture order. The user explicitly captures fields top-to-bottom on each
  // page; that's the sequence we should replay. DOM-based reordering was causing
  // surprises on dynamic / multi-step forms where some elements aren't yet rendered.
  items.sort((a, b) => a.captureOrder - b.captureOrder);

  const tagElement = (selector, element) => { try { element.dataset.qaAutofilledKey = selector; } catch {} };
  const alreadyDone = (selector, element) =>
    fromObserver && element.dataset && element.dataset.qaAutofilledKey === selector;

  const missing = [];
  let submitClicksSkipped = 0;
  let filled = 0;
  for (const item of items) {
    const sel = item.field.selector;

    // Just-in-time re-resolve for items that weren't in the DOM during the initial
    // pass. By now an earlier action (tab click, conditional render) may have injected
    // them. Wait up to 1.2s for the element to appear.
    if (!item.element) {
      const fresh = await waitForElement(sel, 1200);
      if (!fresh) {
        missing.push(item.field.note || sel);
        continue;
      }
      const rebuilt = buildItem(item.field, fresh);
      item.element = rebuilt.element;
      item.value = rebuilt.value;
      item.isClickTarget = rebuilt.isClickTarget;
      item.isSubmitLike = rebuilt.isSubmitLike;
    }

    if (alreadyDone(sel, item.element)) continue;

    // Skip hidden elements silently. On multi-tab wizards, the inactive tab's DOM
    // often stays in the page but invisible — writing into it would either no-op or
    // trigger validation for the wrong tab. We treat hidden elements as "not on this
    // page right now" and move on.
    if (!isElementVisible(item.element)) {
      missing.push(item.field.note || sel);
      continue;
    }

    if (item.isSubmitLike && !settings.clickButtons) {
      submitClicksSkipped++;
      continue;
    }
    if (item.isSubmitLike) await sleep(AUTOFILL_DELAY_BEFORE_BUTTON_MS);
    await applyValueToElement(item.element, item.value);
    tagElement(sel, item.element);
    filled++;
    await sleep(item.isSubmitLike ? AUTOFILL_DELAY_BETWEEN_BUTTONS_MS : AUTOFILL_DELAY_BETWEEN_FIELDS_MS);
  }

  // Visible summary so the user always knows what happened (especially on pages where
  // none of the saved selectors match — previously silent failure).
  const total = totalFields;
  if (filled === 0 && missing.length === total) {
    showBanner(`AutoFill: 0 of ${total} fields matched this page. Saved selectors don't exist here — check dashboard or capture for this page.`, 'warn');
  } else if (missing.length) {
    showBanner(`AutoFill: ${filled} filled, ${missing.length} missing on this page${submitClicksSkipped ? `, ${submitClicksSkipped} button skipped` : ''}.`, 'ok');
  } else {
    showBanner(`AutoFill: ${filled}/${total} filled${submitClicksSkipped ? ` (${submitClicksSkipped} button skipped)` : ''}.`, 'ok');
  }
  setTimeout(hideBanner, 4000);
  } finally {
    isAutofilling = false;
  }
}

function waitForElement(selector, timeout = 3000) {
  return new Promise((resolve) => {
    let el;
    try { el = document.querySelector(selector); } catch { return resolve(null); }
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

function parseDynamicVariables(value) {
  if (typeof value !== 'string') return value;
  const today = () => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  };
  return value
    .replace(/\{\{RANDOM_EMAIL\}\}/g, () => `test_${Math.random().toString(36).substring(2, 9)}@test.com`)
    .replace(/\{\{RANDOM_NUM\}\}/g, () => String(Math.floor(Math.random() * 9000000) + 1000000))
    .replace(/\{\{TODAY\}\}/g, today);
}

// React (and most synthetic-event libraries) listen on mousedown, not click.
// element.click() does NOT fire mousedown/mouseup, so we dispatch the full sequence.
function dispatchClickSequence(el) {
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

function findOptionByText(value) {
  const target = value.trim().toLowerCase();
  // Restrict to elements likely to be option rows; avoid huge full-document scans.
  const candidates = document.querySelectorAll(
    '[class*="option" i], [role="option"], [role="menuitem"], li, [class*="item" i]'
  );
  for (const el of candidates) {
    if (!el.offsetParent) continue; // skip hidden
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt === target) return el;
  }
  // Fallback: leaf text match anywhere visible.
  const all = document.querySelectorAll('div, span, li, p');
  for (const el of all) {
    if (el.children.length !== 0) continue;
    if (!el.offsetParent) continue;
    if ((el.textContent || '').trim().toLowerCase() === target) return el;
  }
  return null;
}

function waitFor(check, timeout = 1500, interval = 50) {
  return new Promise(resolve => {
    const start = Date.now();
    (function tick() {
      const found = check();
      if (found) return resolve(found);
      if (Date.now() - start >= timeout) return resolve(null);
      setTimeout(tick, interval);
    })();
  });
}

async function openAndPickOption(triggerEl, value) {
  const clickable = pickClickTarget(triggerEl);
  dispatchClickSequence(clickable);
  const option = await waitFor(() => findOptionByText(value), 800);
  if (!option) {
    return;
  }
  dispatchClickSequence(option);
  visualizeFill(triggerEl);
}

async function applyValueToElement(element, value) {
  // Backward-compat for selectors captured against a wrapper div that hides a native
  // <select> underneath (opacity:0 overlay pattern). If the saved element is a div
  // wrapping a single <select>, use the inner select so the SELECT branch can run.
  if (element && element.tagName !== 'SELECT' && element.querySelectorAll) {
    const innerSelects = element.querySelectorAll('select');
    if (innerSelects.length === 1) {
      element = innerSelects[0];
    }
  }

  const tagName = element.tagName;
  const type = element.type;

  // 0. Click-only capture (buttons, submit inputs, role=button). Dispatch a real click
  // sequence and return — never write "CLICK" as a text value.
  if (typeof value === 'string' && value.toUpperCase() === 'CLICK') {
    // If we just rerouted from a div to its inner <select>, an explicit CLICK is a
    // no-op for native selects — skip silently rather than firing an event that
    // doesn't open the OS menu anyway.
    if (tagName === 'SELECT') return;
    dispatchClickSequence(element);
    visualizeFill(element);
    return;
  }

  // 1. Radio / Checkbox (click label for DemoQA-style hidden inputs)
  if (type === 'checkbox' || type === 'radio') {
    const isPositive = ['true', '1', 'on', 'yes'].includes(value.toLowerCase());
    if (isPositive !== element.checked) {
      let clickable = element;
      if (element.id) {
        const label = document.querySelector(`label[for="${element.id}"]`);
        if (label) clickable = label;
      }
      clickable.click();
      element.checked = isPositive; 
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    visualizeFill(element.id ? document.querySelector(`label[for="${element.id}"]`) || element : element);
    return;
  }

  // 2. Native Select — works for both vanilla pages AND React/Vue controlled selects.
  // We bypass React's value override by writing through the prototype setter (same trick
  // we use for text inputs), then update `selectedIndex` for vanilla pages, then fire
  // both `input` and `change` so frameworks see a real user-style selection.
  if (tagName === 'SELECT') {
    const options = Array.from(element.options);
    const optionToSelect = options.find(opt =>
      opt.value === value ||
      opt.text.trim().toLowerCase() === value.trim().toLowerCase()
    );
    if (!optionToSelect) return;

    const desiredValue = optionToSelect.value;
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(element, desiredValue);
    } catch {
      element.value = desiredValue;
    }
    element.selectedIndex = optionToSelect.index;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    visualizeFill(element);
    return;
  }

  // 3. CUSTOM REACT DROPDOWN (two-step handling, e.g. DemoQA "Select State")
  if (tagName !== 'INPUT' && tagName !== 'TEXTAREA') {
    if (value.toUpperCase() === 'CLICK') {
      dispatchClickSequence(element);
      return;
    }
    return openAndPickOption(element, value);
  }

  // 4. Standard input
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const prototype = Object.getPrototypeOf(element);
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (valueSetter && valueSetter !== prototypeValueSetter) prototypeValueSetter.call(element, value);
  else if (valueSetter) valueSetter.call(element, value);
  else element.value = value;
  
  if (AUTOFILL_DISPATCH_INPUT_EVENT) element.dispatchEvent(new Event('input', { bubbles: true }));
  if (AUTOFILL_DISPATCH_CHANGE_EVENT) element.dispatchEvent(new Event('change', { bubbles: true }));
  visualizeFill(element);
}

function visualizeFill(element) {
  const originalBg = element.style.backgroundColor;
  const originalTransition = element.style.transition;
  element.style.transition = "background-color 0.4s";
  element.style.backgroundColor = "rgba(59, 130, 246, 0.2)";
  setTimeout(() => {
    element.style.backgroundColor = originalBg;
    setTimeout(() => { element.style.transition = originalTransition; }, 400);
  }, 1000);
}

// --- 4. CROSS-FRAME RELAY ---
// Top frame receives messages from background; relay to child iframes via postMessage
// so picker/autofill works inside <iframe>-embedded forms too.
function relayToChildFrames(action, profileId) {
  for (let i = 0; i < window.frames.length; i++) {
    try {
      window.frames[i].postMessage({ __autofillPro: true, action, profileId }, '*');
    } catch { /* cross-origin frames: that frame's own content script will handle it */ }
  }
}

window.addEventListener('message', (e) => {
  if (!e.data || !e.data.__autofillPro) return;
  const { action, profileId } = e.data;
  if (action === 'startPicker') {
    isPicking = true;
    activeProfileId = profileId;
    capturedThisSession = 0;
    undoStack = [];
    closeInlineEditor();
    clearPendingDropdown();
    chrome.storage.local.get(['qaProfiles'], (r) => {
      activeProfileFields = r.qaProfiles?.[activeProfileId]?.fields || [];
    });
    if (window === window.top) {
      mountOverlay();
      showBanner("Picker active — click fields. Press X Stop Picker (or ESC) to finish.");
    }
  } else if (action === 'runAutoFill') {
    runExecutionEngine(profileId);
  }
  relayToChildFrames(action, profileId);
});

// --- 5. PAGE-LOAD / SPA AUTO-FILL ---
// When "Auto-fill on page load" is enabled, run autofill on:
//   - initial page load
//   - history.pushState / replaceState / popstate (SPA navigations)
//   - DOM mutations introducing new saved fields (hide/show wizards) for 30 seconds
//     after each trigger
let wizardObserver = null;
let wizardObserverDeadline = 0;
let wizardDebounce = null;
let lastObserverFireAt = 0; // throttle for observer-triggered runs

function maybeAutoFillOnLoad(trigger) {
  const url = (window.location.pathname || '/') + (window.location.hash || '');
  if (window !== window.top) {
    return;
  }
  chrome.storage.local.get(['settings', 'activeRunProfile', 'qaProfiles'], (r) => {
    if (!r.settings || !r.settings.autoFillOnLoad) {
      return;
    }
    const profileId = r.activeRunProfile;
    if (!profileId || !r.qaProfiles || !r.qaProfiles[profileId]) {
      return;
    }
    const fields = r.qaProfiles[profileId].fields || [];
    if (!fields.length) {
      return;
    }

    // Initial autofill once the DOM settles.
    setTimeout(() => {
      lastObserverFireAt = Date.now(); // suppress observer re-fire for the next few seconds
      runExecutionEngine(profileId);
      relayToChildFrames('runAutoFill', profileId);
    }, 600);

    // Open a 30-second observation window — handles wizards that swap step content
    // in place (no real navigation). When new nodes appear and a saved selector now
    // matches a fresh element, re-run autofill (debounced).
    armWizardObserver(profileId, fields);
  });
}

function armWizardObserver(profileId, fields) {
  wizardObserverDeadline = Date.now() + 30000;
  if (wizardObserver) return; // already armed; just extend the deadline
  wizardObserver = new MutationObserver(() => {
    if (Date.now() > wizardObserverDeadline) {
      wizardObserver.disconnect();
      wizardObserver = null;
      return;
    }
    if (wizardDebounce) clearTimeout(wizardDebounce);
    wizardDebounce = setTimeout(() => {
      // Throttle: don't fire if another run just happened (manual Alt+F or initial load).
      // Without this the observer would re-trigger right after a normal autofill completes
      // and the page mutates as a result — double-submits.
      if (isAutofilling) return;
      if (Date.now() - lastObserverFireAt < AUTOFILL_OBSERVER_MIN_INTERVAL_MS) return;
      const hasFreshMatch = fields.some(f => {
        try {
          const el = document.querySelector(f.selector);
          if (!el) return false;
          // "Fresh" = element exists but hasn't been autofilled yet in this lifecycle.
          if (el.dataset.qaAutofilledKey === f.selector) return false;
          // For text/textarea, also skip if value already matches (avoid loops).
          if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
              el.value && el.value === parseDynamicVariables(f.value)) return false;
          return true;
        } catch { return false; }
      });
      if (hasFreshMatch) {
        lastObserverFireAt = Date.now();
        runExecutionEngine(profileId, { fromObserver: true });
        relayToChildFrames('runAutoFill', profileId);
      }
    }, 350);
  });
  wizardObserver.observe(document.body, { childList: true, subtree: true });
  // Auto-tear-down at the deadline regardless of mutations.
  setTimeout(() => {
    if (wizardObserver && Date.now() >= wizardObserverDeadline) {
      wizardObserver.disconnect();
      wizardObserver = null;
    }
  }, 30000);
}

// SPA navigation detection — pushState/replaceState/popstate don't fire 'load'.
(function hookHistory() {
  const fire = (source) => {
    window.dispatchEvent(new Event('autofill-locationchange'));
  };
  const _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); fire('pushState'); };
  const _replace = history.replaceState;
  history.replaceState = function () { _replace.apply(this, arguments); fire('replaceState'); };
  window.addEventListener('popstate', () => fire('popstate'));
})();
window.addEventListener('autofill-locationchange', () => maybeAutoFillOnLoad('locationchange'));
window.addEventListener('load', () => maybeAutoFillOnLoad('load'));
// Also try once after script load (in case page is already loaded when content script runs).
if (document.readyState === 'complete') maybeAutoFillOnLoad('script-init');

// URL polling fallback — Angular/React routers sometimes cache history.pushState
// before our content script (run_at: document_idle) gets to patch it, which
// makes our pushState hook silently miss SPA navigations. Poll the URL every
// 500ms as a guaranteed signal that we always catch.
let __autofillLastUrl = (window.location.pathname || '/') + (window.location.hash || '');
setInterval(() => {
  const u = (window.location.pathname || '/') + (window.location.hash || '');
  if (u !== __autofillLastUrl) {
    __autofillLastUrl = u;
    window.dispatchEvent(new Event('autofill-locationchange'));
  }
}, 500);