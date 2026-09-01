// BB's in-app browser, reached through the desktop shell's renderer API.
//
// WHY THIS REACHES OUTSIDE THE SDK
//
// GitHub cannot be shown in an iframe — it serves `x-frame-options: deny` and
// `frame-ancestors 'none'`. BB's own Browser tab escapes that because it is a
// main-process Electron `WebContentsView`, which is a top-level frame rather
// than a child one. The renderer drives it over `window.bbDesktop.browser`,
// and plugin frontends are imported into that same realm, so the API is
// reachable here.
//
// It is NOT part of `@get-bb/plugin-sdk`, so nothing guarantees it. BB's own
// declaration already marks `focus`, `setVisibleWithoutFocus` and
// `onScopedOpenTab` "optional for version skew", so the surface does move.
// Everything here is therefore feature-detected method by method, and
// `getDesktopBrowser` returns null the moment anything it needs is missing —
// on the web build, where `window.bbDesktop` is undefined, and on any desktop
// build that has changed the shape. Callers must have a fallback.
//
// The view is a native overlay positioned in window coordinates, not a DOM
// node: it does not clip, scroll, or stack with our markup. `measureBounds`
// mirrors what BB's own browser deck does, including clamping to the viewport,
// because the IPC schema rejects a negative size.
//
// Views outlive the component that shows them — see `showView` — because a
// fixed tab unmounts on every deselect, and tearing the view down there would
// reload the page every time the tab came back.

/** Window-relative CSS pixels, as the attach/setBounds IPC expects. */
export interface DesktopBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A navigation-state push for one view. */
export interface DesktopBrowserState {
  tabId: string;
  url: string;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  errorText: string;
}

/** The subset of BB's browser API this plugin uses. */
export interface DesktopBrowser {
  attach(request: {
    tabId: string;
    url: string;
    bounds: DesktopBrowserBounds;
    visible: boolean;
  }): void;
  detach(tabId: string): void;
  navigate(request: { tabId: string; url: string }): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  setBounds(request: { tabId: string; bounds: DesktopBrowserBounds }): void;
  setVisible(request: { tabId: string; visible: boolean }): void;
  onState(listener: (state: DesktopBrowserState) => void): () => void;
}

declare global {
  interface Window {
    /**
     * The desktop shell's renderer API. Optional throughout: absent entirely
     * on the web build, and individual methods come and go between versions.
     */
    bbDesktop?: { browser?: Partial<DesktopBrowser> };
  }
}

/**
 * The event BB dispatches when a layout change means views must re-measure —
 * panel resize, split changes, collapse. BB's own browser deck listens to it,
 * so honouring it keeps a plugin-driven view in step with the panel.
 */
export const BOUNDS_SYNC_EVENT = "bb:browser-view-bounds-sync";

// One wrapper per underlying shell object, so `getDesktopBrowser()` is stable
// across calls and the view registry below can key off its identity.
const wrappers = new WeakMap<object, DesktopBrowser>();

/**
 * BB's browser, or null when this client cannot provide one.
 *
 * Every method is checked, so a build that has renamed or dropped one falls
 * back rather than throwing halfway through attaching a view.
 */
export function getDesktopBrowser(): DesktopBrowser | null {
  const candidate = typeof window === "undefined" ? undefined : window.bbDesktop?.browser;
  if (candidate === undefined) return null;
  const wrapped = wrappers.get(candidate);
  if (wrapped !== undefined) return wrapped;
  const { attach, detach, navigate, goBack, goForward, reload, setBounds, setVisible, onState } =
    candidate;
  if (
    typeof attach !== "function" ||
    typeof detach !== "function" ||
    typeof navigate !== "function" ||
    typeof goBack !== "function" ||
    typeof goForward !== "function" ||
    typeof reload !== "function" ||
    typeof setBounds !== "function" ||
    typeof setVisible !== "function" ||
    typeof onState !== "function"
  ) {
    return null;
  }
  // Bound to the original object: these are context-bridge functions, and
  // detaching them from their receiver is not something to assume is safe.
  const browser: DesktopBrowser = {
    attach: (request) => attach.call(candidate, request),
    detach: (tabId) => detach.call(candidate, tabId),
    navigate: (request) => navigate.call(candidate, request),
    goBack: (tabId) => goBack.call(candidate, tabId),
    goForward: (tabId) => goForward.call(candidate, tabId),
    reload: (tabId) => reload.call(candidate, tabId),
    setBounds: (request) => setBounds.call(candidate, request),
    setVisible: (request) => setVisible.call(candidate, request),
    onState: (listener) => onState.call(candidate, listener),
  };
  wrappers.set(candidate, browser);
  return browser;
}

interface ViewState {
  /** How many mounted panes are showing this view. */
  mounts: number;
  /** Whether its page has been loaded, so a reuse does not re-navigate. */
  loaded: boolean;
  /** What this view belongs to. Views outlive their pane but not their group. */
  group: string;
}

/**
 * The views each browser currently owns.
 *
 * A fixed tab unmounts whenever it is deselected or the panel closes, so a
 * view cannot be tied to its component's lifetime: destroying it there means
 * re-selecting the tab reloads the page. A view outlives its pane instead, and
 * is reclaimed when a view from a different `group` needs one — the only
 * moment the old one is certainly finished with. Views in the same group (a
 * review's pull request and its diff, say) coexist, so moving between them
 * costs nothing.
 */
const registries = new WeakMap<DesktopBrowser, Map<string, ViewState>>();

function registryFor(browser: DesktopBrowser): Map<string, ViewState> {
  const existing = registries.get(browser);
  if (existing !== undefined) return existing;
  const created = new Map<string, ViewState>();
  registries.set(browser, created);
  return created;
}

/**
 * Show `tabId`'s view, creating it the first time and reusing it after.
 *
 * The URL is sent only on creation. BB reuses an existing view and skips the
 * load for an empty URL, so a re-selected tab comes back exactly where the
 * reader left it rather than jumping to the pull request's front page.
 */
export function showView(
  browser: DesktopBrowser,
  view: { tabId: string; url: string; bounds: DesktopBrowserBounds; group: string },
): void {
  const views = registryFor(browser);
  const state = views.get(view.tabId) ?? { mounts: 0, loaded: false, group: view.group };
  state.mounts += 1;
  views.set(view.tabId, state);
  browser.attach({
    tabId: view.tabId,
    url: state.loaded ? "" : view.url,
    bounds: view.bounds,
    visible: true,
  });
  state.loaded = true;
  // Anything from another group that nothing is showing belongs to a review
  // that has been left, so its page is not worth what a live view costs.
  for (const [tabId, other] of views) {
    if (other.group === view.group || other.mounts > 0) continue;
    browser.detach(tabId);
    views.delete(tabId);
  }
}

/** Point an existing view at another page, or load it if it is not up yet. */
export function navigateView(browser: DesktopBrowser, tabId: string, url: string): void {
  const state = registryFor(browser).get(tabId);
  if (state === undefined || !state.loaded) return;
  browser.navigate({ tabId, url });
}

/** Hide `tabId`'s view, keeping its page for the next time it is shown. */
export function hideView(browser: DesktopBrowser, tabId: string): void {
  const state = registryFor(browser).get(tabId);
  if (state === undefined) return;
  state.mounts = Math.max(0, state.mounts - 1);
  if (state.mounts > 0) return;
  browser.setVisible({ tabId, visible: false });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * An element's rectangle in the shape the IPC wants, clamped to the viewport.
 *
 * A view whose element is scrolled out of the panel would otherwise measure as
 * a negative size, which the request schema rejects outright.
 */
export function measureBounds(element: Element): DesktopBrowserBounds {
  const rect = element.getBoundingClientRect();
  const right = Math.max(0, Math.round(window.innerWidth));
  const bottom = Math.max(0, Math.round(window.innerHeight));
  const x = clamp(Math.round(rect.left), 0, right);
  const y = clamp(Math.round(rect.top), 0, bottom);
  return {
    x,
    y,
    width: clamp(Math.round(rect.left) + Math.round(rect.width), x, right) - x,
    height: clamp(Math.round(rect.top) + Math.round(rect.height), y, bottom) - y,
  };
}

export function sameBounds(a: DesktopBrowserBounds, b: DesktopBrowserBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
