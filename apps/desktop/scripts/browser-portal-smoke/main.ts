/**
 * Headless smoke for the global portal-popup watcher
 * (renderer/lib/browserPortalWatcher.ts) against the REAL
 * renderer/lib/browserOcclusion.ts registry.
 *
 * No DOM library exists in the workspace (no jsdom/happy-dom/vitest), so the
 * smoke hand-stubs the DOM surface the watcher touches: document.body with a
 * mini selector engine honoring the watcher's exact selector semantics
 * (`[role="X"][data-open]` alternatives), a synchronous requestAnimationFrame,
 * a recording MutationObserver, a no-op window timer surface, and an
 * HTMLElement base class the fakes extend (the watcher's `instanceof` filter).
 * The session store is stubbed (stub-store.ts, esbuild alias) so the counter
 * discipline is asserted through the recorded suppressBrowserView calls.
 *
 * Assertions:
 *  A. POPUP_SELECTOR couples to base-ui's actual role literals (menu root
 *     'menu', select popup 'listbox', dialog root 'dialog'/'alertdialog') and
 *     requires [data-open] on every alternative — the same style of
 *     string-level coupling guard as the terminal-title dictionary smoke.
 *  B. Classification: menu/listbox/dialog → geometry-aware union occluder;
 *     alertdialog → null (full-window) occluder.
 *  C. Entry-transition popup (<1px) registers the UNMEASURED sentinel, never
 *     a null rect (the "browser flashes when a select opens" regression).
 *  D. Counter discipline: exactly one hold while popups are open across
 *     repeated rescans, exactly one release when they all close; occluder
 *     ids are unregistered (registry version bumps).
 *  E. shouldSuppressBrowserView integration with a stage rect: overlapping
 *     menu suppresses, non-overlapping doesn't, alertdialog always does.
 */
import {
  getOcclusionVersion,
  shouldSuppressBrowserView,
  setBrowserStageRect,
  type OcclusionRect,
} from "@renderer/lib/browserOcclusion.js";
import {
  startPortalPopupWatcher,
  stopPortalPopupWatcher,
  POPUP_SELECTOR_FOR_TESTS,
} from "@renderer/lib/browserPortalWatcher.js";
import { suppressCalls } from "./stub-store.js";

/** Elements currently "in the DOM" — the stub querySelectorAll scans this. */
let liveElements: FakeEl[] = [];
let observerCallback: (() => void) | null = null;
let rafCalls = 0;

class FakeHTMLElement {}
globalThis.HTMLElement = FakeHTMLElement as unknown as typeof HTMLElement;

class FakeEl extends FakeHTMLElement {
  isConnected = true;
  constructor(
    public role: string,
    public dataOpen: boolean,
    public rect: { x: number; y: number; w: number; h: number } | null,
  ) {
    super();
  }
  getBoundingClientRect() {
    const r = this.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h,
      width: r.w, height: r.h, x: r.x, y: r.y, toJSON: () => ({}),
    };
  }
  /** Only the watcher's modal-classification selector. */
  matches(sel: string): boolean {
    return sel === '[role="alertdialog"][data-open]' && this.role === "alertdialog" && this.dataOpen;
  }
}

// Minimal selector engine for the watcher's POPUP_SELECTOR alternatives.
function fakeQuerySelectorAll(selector: string): FakeEl[] {
  const alts = selector.split(",").map((s) => s.trim());
  return liveElements.filter((el) =>
    alts.some((alt) => {
      const m = alt.match(/^\[role="([a-z]+)"\]\[data-open\]$/);
      return m !== null && el.role === m[1] && el.dataOpen;
    }),
  );
}

(globalThis as Record<string, unknown>).document = {
  body: { querySelectorAll: (sel: string) => fakeQuerySelectorAll(sel) },
};
(globalThis as Record<string, unknown>).MutationObserver = class {
  constructor(cb: () => void) {
    observerCallback = cb;
  }
  observe() {}
  disconnect() {}
};
// rAF stub MUST defer the callback to a microtask: the watcher assigns
// `scheduledRaf = requestAnimationFrame(cb)`, and a SYNCHRONOUS stub would
// run cb (which resets scheduledRaf to 0) INSIDE the assignment expression —
// the returned id then overwrites the reset and every later rescan
// early-returns. Real rAF is always async; the microtask preserves that.
(globalThis as Record<string, unknown>).requestAnimationFrame = (fn: () => void) => {
  rafCalls += 1;
  const id = rafCalls;
  void Promise.resolve().then(() => fn());
  return id;
};
(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
(globalThis as Record<string, unknown>).window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: () => 0,
  clearTimeout() {},
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}`);
  }
}
const holds = (): number => suppressCalls.filter(Boolean).length;
const releases = (): number => suppressCalls.filter((c) => !c).length;

/** Fire a "DOM mutation": swap the live elements, notify the observer, then
 *  flush the deferred rAF microtask so the rescan has run when we return. */
async function mutate(els: FakeEl[]): Promise<void> {
  liveElements = els;
  if (observerCallback) observerCallback();
  await null;
  await null;
}

function stage(x: number, y: number, w: number, h: number): void {
  setBrowserStageRect({ left: x, top: y, right: x + w, bottom: y + h } as OcclusionRect);
}

async function main(): Promise<void> {
  console.log("browser portal watcher smoke");

  console.log("A. selector coupling");
  const alts = POPUP_SELECTOR_FOR_TESTS.split(",").map((s) => s.trim());
  check("selector covers menu", alts.includes('[role="menu"][data-open]'));
  check("selector covers listbox", alts.includes('[role="listbox"][data-open]'));
  check("selector covers dialog", alts.includes('[role="dialog"][data-open]'));
  check("selector covers alertdialog", alts.includes('[role="alertdialog"][data-open]'));
  check("tooltip deliberately not tracked", !alts.some((a) => a.includes("tooltip")));
  check("every alternative requires data-open", alts.every((a) => a.endsWith("[data-open]")));

  console.log("B. classification + geometry");
  startPortalPopupWatcher();
  check("started: observer installed", observerCallback !== null);

  // Stage on the right half; a menu over the LEFT half must not suppress.
  stage(600, 0, 400, 800);
  await mutate([new FakeEl("menu", true, { x: 100, y: 100, w: 160, h: 120 })]);
  check("non-overlapping menu: view stays up", shouldSuppressBrowserView() === false);
  check("counter held exactly once on open", holds() === 1 && releases() === 0);

  // Same state rescanned again must not re-hold the counter.
  await mutate([new FakeEl("menu", true, { x: 100, y: 100, w: 160, h: 120 })]);
  check("repeated rescan: no extra hold", holds() === 1);

  // Menu moves over the stage → suppress.
  await mutate([new FakeEl("menu", true, { x: 700, y: 100, w: 160, h: 120 })]);
  check("overlapping menu: view hides", shouldSuppressBrowserView() === true);

  console.log("C. entry-transition sentinel");
  await mutate([new FakeEl("listbox", true, null)]);
  check("zero-size popup does NOT full-suppress", shouldSuppressBrowserView() === false);

  console.log("D. counter + registry discipline");
  const vOpen = getOcclusionVersion();
  await mutate([]);
  check("all closed: released exactly once", releases() === 1);
  check("all closed: registry changed (occluder unregistered)", getOcclusionVersion() > vOpen);

  console.log("E. alertdialog full suppress");
  await mutate([new FakeEl("dialog", true, { x: 100, y: 100, w: 200, h: 80 })]);
  check("popover-like dialog (left side): geometry-aware only", shouldSuppressBrowserView() === false);
  await mutate([
    new FakeEl("dialog", true, { x: 100, y: 100, w: 200, h: 80 }),
    new FakeEl("alertdialog", true, { x: 100, y: 100, w: 200, h: 80 }),
  ]);
  check("alertdialog present: full suppress regardless of geometry", shouldSuppressBrowserView() === true);
  await mutate([]);
  check("after alertdialog close: released again", holds() === 2 && releases() === 2);

  console.log("F. stop() releases everything");
  await mutate([new FakeEl("menu", true, { x: 700, y: 100, w: 160, h: 120 })]);
  stopPortalPopupWatcher();
  check("stop: counter released", suppressCalls[suppressCalls.length - 1] === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
