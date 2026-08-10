/**
 * Page-snapshot script, injected into the browser view's page main world via
 * `webContents.executeJavaScript()` when an agent calls the `browser_snapshot`
 * tool.
 *
 * Like `pickerScript.ts`, this is a string constant (NOT a module) because
 * executeJavaScript runs in the page's own context with no access to our
 * process's module scope. The IIFE returns a plain JSON-serializable object,
 * which Electron auto-marshals back across the process boundary as the
 * awaited return value — no IPC round-trip needed.
 *
 * Security: read-only w.r.t. the page. It queries the DOM, computes stable
 * selectors, and returns structured data. It never modifies the page, never
 * calls eval, and never touches Node/Electron APIs. Selectors returned here
 * are later consumed by `CLICK_SCRIPT` via `querySelector` (no string
 * interpolation into script source).
 */

/** Caps so a giant page can't blow up the agent's context window. */
export const SNAPSHOT_HTML_CAP = 20000;
export const SNAPSHOT_TEXT_CAP = 8000;
/** Cap the number of interactive elements collected, to bound payload size. */
export const SNAPSHOT_INTERACTIVE_CAP = 120;

/**
 * Returns `{ url, title, readyState, html, bodyText, interactive }`.
 * `interactive` is a compact a11y-ish list (role / accessible-name / tag /
 * stable selector / visible-text-snippet) for the elements an agent is most
 * likely to act on: links, buttons, inputs, selects, textareas, elements with
 * an explicit role, and headings. Each entry's `selector` can be passed back
 * to `browser_click`.
 */
export const SNAPSHOT_SCRIPT = `
(function () {
  var htmlCap = ${SNAPSHOT_HTML_CAP};
  var textCap = ${SNAPSHOT_TEXT_CAP};
  var intCap = ${SNAPSHOT_INTERACTIVE_CAP};

  function clip(s, n) {
    if (!s) return '';
    s = String(s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }

  // Stable CSS selector for an element: prefer id, then a class chain, falling
  // back to nth-child path. Mirrors pickerScript's buildSelector so selectors
  // are consistent between the human picker and the agent snapshot/click path.
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  }

  // Best-effort accessible name: aria-label/aria-labelledby > associated
  // <label> > visible inner text.
  function accName(el) {
    var labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      var targets = labelled.split(/\\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      if (targets.length) return clip(targets.map(function (t) { return t.textContent; }).join(' '), 80);
    }
    var al = el.getAttribute('aria-label');
    if (al) return clip(al, 80);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent) return clip(lbl.textContent, 80);
      }
      var ph = el.getAttribute('placeholder');
      if (ph) return clip(ph, 80);
    }
    return clip(el.textContent, 80);
  }

  var interactive = [];
  var selector = 'a, button, input, select, textarea, [role], h1, h2, h3, h4, h5, h6';
  var nodes = document.querySelectorAll(selector);
  for (var i = 0; i < nodes.length && interactive.length < intCap; i++) {
    var el = nodes[i];
    // Skip elements not visible in the layout (display:none / hidden ancestors).
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    }
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    interactive.push({
      role: role,
      name: accName(el),
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      text: clip(el.textContent, 60),
    });
  }

  var html = document.documentElement ? document.documentElement.outerHTML : '';
  var bodyText = document.body ? document.body.innerText : '';

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    html: clip(html, htmlCap),
    bodyText: clip(bodyText, textCap),
    interactive: interactive,
  };
})();
`;

/**
 * Click script: locates an element by CSS selector and clicks it. Returns the
 * post-click url + title so the caller can tell whether the click triggered a
 * navigation. The selector is passed in via a JSON-stringified argument and
 * resolved with `querySelector` — it is never interpolated into script source,
 * so a malformed/hostile selector can't break out of the querySelector call.
 */
export const CLICK_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  try {
    el.click();
  } catch (e) {
    return { error: 'click threw: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, url: location.href, title: document.title };
})(%SELECTOR_JSON%);
`;

/**
 * Build a ready-to-execute click script from a selector. The selector is
 * JSON-encoded (which produces a valid JS string literal) and substituted into
 * the `%SELECTOR_JSON%` slot. Because JSON.stringify already escapes quotes /
 * backslashes / control chars, this is safe against selector injection.
 */
export function buildClickScript(selector: string): string {
  return CLICK_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

/**
 * Type/fill script: locates an element by CSS selector and sets its value to
 * the given text. Handles <input>, <textarea> and contenteditable elements.
 *
 * Value-setting strategy: instead of assigning `el.value = text` directly
 * (which silently no-ops on React/Vue controlled inputs because the framework
 * owns the value via its own setter), we use the element prototype's native
 * value setter and then dispatch `input` + `change` events. React's onChange
 * listens to the native `input` event, so the framework's state updates and
 * the controlled value round-trips correctly.
 *
 * Both the selector and the text are passed in as JSON-stringified arguments
 * and never interpolated into script source, so a hostile selector OR text
 * (quotes / backslashes / newlines / `</script>`) can't break out.
 */
export const TYPE_SCRIPT = `
(function (selectorJson, textJson) {
  var sel, text;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  try { text = JSON.parse(textJson); } catch (e) { return { error: 'invalid text json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  if (typeof text !== 'string') return { error: 'text must be a string' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  try {
    el.focus();
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // Contenteditable: replace text content directly (keeps formatting tags).
      el.textContent = text;
    } else if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    } else if (el.tagName === 'INPUT') {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (!desc || !desc.set) return { error: 'input value setter unavailable' };
      desc.set.call(el, text);
    } else {
      return { error: 'element is not an input, textarea or contenteditable: ' + sel };
    }
    // Dispatch change/input so framework state (React/Vue) picks the value up.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { error: 'type threw: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, url: location.href, title: document.title };
})(%SELECTOR_JSON%, %TEXT_JSON%);
`;

/**
 * Build a ready-to-execute type script from a selector + text. Both are
 * JSON-encoded (valid JS string literals) and substituted into their slots —
 * same injection-safe pattern as buildClickScript.
 */
export function buildTypeScript(selector: string, text: string): string {
  return TYPE_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)))
    .replace("%TEXT_JSON%", JSON.stringify(JSON.stringify(text)));
}

/**
 * Evaluate script: runs arbitrary JS in the page's main world via
 * `new Function(code)()` and returns a JSON-serialized view of the result.
 * This is the "model can modify the page DOM directly" escape hatch —
 * anything reachable from the page (text nodes, styles, attributes, events)
 * can be changed. The code is passed in as a JSON-stringified argument (same
 * pattern as CLICK_SCRIPT / TYPE_SCRIPT) so quotes / backslashes / newlines
 * in the code can't break the injected script's syntax.
 *
 * Result serialization: JSON.stringify succeeds for plain data; DOM elements,
 * functions and cyclic objects fall back to String(result) (e.g. "[object
 * HTMLHeadingElement]"), and undefined reports "(undefined)". The caller gets
 * a text snapshot of what the script returned so it can verify its changes.
 */
export const EVALUATE_SCRIPT = `
(function (scriptJson) {
  var code;
  try { code = JSON.parse(scriptJson); } catch (e) { return { error: 'invalid script json' }; }
  if (typeof code !== 'string' || !code) return { error: 'empty script' };
  var result;
  try {
    result = new Function(code)();
  } catch (e) {
    return { error: 'script threw: ' + (e && e.message ? e.message : String(e)) };
  }
  var text;
  if (result === undefined) {
    text = '(undefined)';
  } else {
    try {
      text = JSON.stringify(result, null, 2);
      if (text === undefined) text = String(result);
    } catch (e) {
      text = String(result);
    }
  }
  return { ok: true, result: text, url: location.href, title: document.title };
})(%SCRIPT_JSON%);
`;

/**
 * Build a ready-to-execute evaluate script from JS code. The code is
 * JSON-encoded (a valid JS string literal) and substituted into the
 * `%SCRIPT_JSON%` slot — same injection-safe pattern as the other builders.
 */
export function buildEvaluateScript(code: string): string {
  return EVALUATE_SCRIPT.replace("%SCRIPT_JSON%", JSON.stringify(JSON.stringify(code)));
}
