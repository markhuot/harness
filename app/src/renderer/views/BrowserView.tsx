// Live view of a session's headless Chrome: the screencast frames of one of its tabs drawn onto a
// canvas, with mouse/keyboard input forwarded back to the page over the WebSocket. A strip above
// the bar switches between the session's tabs once it has more than one.
//
// Each view is its own viewer of the session (`viewerId`, its pane's id), so a ticket's Browser and
// a browser tab torn off beside it (or two torn-off tabs) stream side by side, each taking its own
// input, and closing one leaves the others watching. In a ticket, a chip drags off into a pane
// pinned to that browser tab (`pinnedTab`: no strip); a chip torn off shows a placeholder here.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isBrowserEventFor, type BrowserInput, type BrowserState, type BrowserTab } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { fitRect, normalizeUrl, toPagePoint, type Rect } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { useAnnotate } from "../components/Annotator";
import { browserShotName } from "../state/annotator";
import { isAppChord } from "../state/keys";
import { confirmsClose, confirmsNewTab, confirmsSwitch, frameIsForView, tabLabel, tabTooltip, type ViewTab } from "../state/browserTabs";
import { returnTabPane, type TabDrag, type TornOff } from "../state/panes";
import { usePane } from "../components/paneContext";
import { dragProps, tabContextMenu } from "../components/paneDrag";
import { TornMark, TornPlaceholder } from "../components/TornOff";
import "./browser.css";

/** A ticket's browser, where its chips tear off: the ticket, where its panes are, and which of its tabs are torn off. */
export interface BrowserTear {
  ticketKey: string;
  /** The pane scope this view is in, and the board this window shows (useBoardScope). */
  scope: string;
  boardScope: string;
  paneId: string;
  torn: Map<string, TornOff>;
}

let viewerCounter = 0;

function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

/** Frame counters for tests/diagnostics (window.__harnessBrowser). */
const debugStats = { frames: 0, drawn: 0, errors: 0 };
(window as unknown as { __harnessBrowser: typeof debugStats }).__harnessBrowser = debugStats;
const PAGE_META_KEYS = new Set(["a", "c", "x", "z"]);


export function BrowserView({
  sessionId,
  pinnedTab,
  tear,
  onPinnedClosed,
  onTitle,
}: {
  sessionId: string;
  /** Show only this browser tab (a torn-off browser tab's pane): subscribed to it, with no chip strip. */
  pinnedTab?: number;
  /** In a ticket: chips tear off, and torn-off ones show a placeholder here. */
  tear?: BrowserTear;
  /** The pinned tab was closed (in the strip of another view, or by the agent). */
  onPinnedClosed?: () => void;
  /** The shown page's title, as it changes (a pinned tab's pane header). */
  onTitle?: (title: string) => void;
}) {
  const { socket, client, onEvent, epoch } = useStore();
  const act = useAction();
  // This view's viewer: its pane's id (unique in this window), else one of its own.
  const paneId = usePane()?.paneId;
  const [ownId] = useState(() => `v${++viewerCounter}`);
  const viewerId = paneId ?? ownId;
  const [state, setState] = useState<BrowserState | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [live, setLive] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const editingUrl = useRef(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frame = useRef<{ bitmap: ImageBitmap | null; width: number; height: number }>({ bitmap: null, width: 0, height: 0 });
  const drawn = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const decoding = useRef(false);
  const pending = useRef<{ data: string; width: number; height: number } | null>(null);
  const lastFrameAt = useRef(0);
  /** Bumped whenever the canvas is cleared, so a frame still decoding from before is dropped. */
  const frameGen = useRef(0);
  /** The tab this view shows (see ViewTab); frames from any other tab are ignored. */
  const viewTab = useRef<ViewTab>(undefined);
  /** After switching, opening or closing a tab: the browser.state that confirms it. States still in
   * flight from before (the old tab's) are dropped until it arrives, or for a few seconds at most. */
  const expecting = useRef<{ accepts: (s: BrowserState) => boolean; until: number } | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const annotator = useAnnotate();
  const [shooting, setShooting] = useState(false);

  const send = useCallback(
    (input: BrowserInput) => {
      const tab = viewTab.current;
      socket.send(typeof tab === "number" ? { type: "browser.input", sessionId, viewerId, tabId: tab, input } : { type: "browser.input", sessionId, viewerId, input });
    },
    [socket, sessionId, viewerId],
  );

  // ------------------------------------------------------------------ drawing

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { bitmap, width, height } = frame.current;
    if (!bitmap) return;
    // Frames are page CSS pixels; fit that page into the stage, full bleed (the page is resized to the stage).
    const r = fitRect(cw, ch, width || bitmap.width, height || bitmap.height);
    drawn.current = r;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
  }, []);

  /** Blank the canvas (a new session, or another tab) until that tab's first frame arrives. */
  const clearFrame = useCallback(() => {
    frameGen.current++;
    pending.current = null;
    frame.current.bitmap?.close();
    frame.current = { bitmap: null, width: 0, height: 0 };
    draw();
    setHasFrame(false);
  }, [draw]);

  const decode = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        const gen = frameGen.current;
        pending.current = null;
        const mime = next.data.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        try {
          // Decode via <img> (img-src data: is allowed by the CSP; fetch() of data: URLs isn't
          // reliable once webSecurity is on).
          const img = new Image();
          img.src = `data:${mime};base64,${next.data}`;
          await img.decode();
          const bitmap = await createImageBitmap(img);
          if (gen !== frameGen.current) {
            bitmap.close();
            continue;
          }
          frame.current.bitmap?.close();
          frame.current = { bitmap, width: next.width, height: next.height };
          draw();
          debugStats.drawn++;
          setHasFrame(true);
        } catch (err) {
          // Corrupt frame: skip it, the next one will replace it.
          debugStats.errors++;
          console.warn("browser frame decode failed", err);
        }
      }
    } finally {
      decoding.current = false;
    }
  }, [draw]);

  // ------------------------------------------------------------------ subscription

  /** Take a browser.state for this view: a different tabId means the service moved this socket
   * (a new tab, the shown one closed, a reconnect after it closed), so the old frame goes. */
  const applyState = useCallback(
    (s: BrowserState) => {
      const want = expecting.current;
      if (want) {
        if (!want.accepts(s) && Date.now() < want.until) return;
        expecting.current = null;
      }
      if (s.tabId !== undefined && viewTab.current !== s.tabId) {
        if (viewTab.current !== undefined) clearFrame();
        viewTab.current = s.tabId;
      }
      socket.noteBrowserTab(sessionId, s.tabId, viewerId);
      setState(s);
    },
    [socket, sessionId, viewerId, clearFrame],
  );

  useEffect(() => {
    setState(null);
    clearFrame();
    viewTab.current = pinnedTab;
    expecting.current = null;
    socket.subscribeBrowser(sessionId, pinnedTab, viewerId);
    const off = onEvent((e) => {
      if (!isBrowserEventFor(e, sessionId, viewerId)) return;
      if (e.kind === "browser.frame") {
        if (!frameIsForView(e.tabId, viewTab.current)) return;
        debugStats.frames++;
        lastFrameAt.current = Date.now();
        setLive(true);
        pending.current = { data: e.data, width: e.width, height: e.height };
        void decode();
      } else {
        applyState(e.state);
      }
    });
    return () => {
      off();
      // Only this viewer: another view of the session (a torn-off tab) keeps streaming.
      socket.unsubscribeBrowser(sessionId, viewerId);
    };
  }, [sessionId, pinnedTab, viewerId, socket, onEvent, decode, clearFrame, applyState]);

  // A pinned tab that's gone (closed in another view, or by the agent) takes its pane with it.
  const pinnedGone = pinnedTab !== undefined && !!state?.tabs && !state.tabs.some((t) => t.id === pinnedTab);
  useEffect(() => {
    if (pinnedGone) onPinnedClosed?.();
  }, [pinnedGone]);
  const title = state ? tabLabel({ title: state.title ?? "", url: state.url ?? "" }) : "";
  useEffect(() => onTitle?.(title), [title]);

  useEffect(() => {
    let cancelled = false;
    const asked = viewTab.current;
    client
      .browserState(sessionId, typeof asked === "number" ? asked : undefined)
      .then((s) => {
        // Only while it still describes the tab on screen (the socket may have moved meanwhile).
        if (cancelled || !s) return;
        const tab = viewTab.current;
        if (s.tabId === undefined || tab === undefined || tab === s.tabId) applyState(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, epoch, applyState]);

  useEffect(() => {
    if (!editingUrl.current) setUrlDraft(state?.url ?? "");
  }, [state?.url]);

  // "Live" indicator decays when frames stop.
  useEffect(() => {
    const t = setInterval(() => setLive(Date.now() - lastFrameAt.current < 2000), 500);
    return () => clearInterval(t);
  }, []);

  // ------------------------------------------------------------------ resize

  // The service restarts the screencast on every resize, and overlapping restarts (or one that
  // races the subscribe) leave the tab without frames. So: send nothing until the subscription
  // is confirmed (first browser.state for this session), then only real size changes, debounced.
  const subscribed = useRef(false);
  const lastSize = useRef("");
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendResize = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !subscribed.current) return;
    const width = Math.round(stage.clientWidth);
    const height = Math.round(stage.clientHeight);
    const key = sizeKey(width, height);
    if (width <= 0 || height <= 0 || key === lastSize.current) return;
    lastSize.current = key;
    send({ type: "resize", width, height });
  }, [send]);
  const scheduleResize = useCallback(
    (ms = 250) => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(sendResize, ms);
    },
    [sendResize],
  );

  /**
   * The tab at the pane's size before a screenshot: a resize still waiting on its debounce goes
   * now, then this waits (up to 2 s) for a frame at that size. A screenshot taken before the
   * resize lands would show the page at its old size, and every element lookup on it would come
   * back empty once the tab is resized under it.
   */
  const settleSize = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || !subscribed.current) return;
    if (resizeTimer.current) {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = null;
    }
    sendResize();
    const want = sizeKey(stage.clientWidth, stage.clientHeight);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && sizeKey(frame.current.width, frame.current.height) !== want) await new Promise((r) => setTimeout(r, 50));
  }, [sendResize]);

  useEffect(() => {
    // New session or reconnect: the service-side subscription starts over.
    subscribed.current = false;
    lastSize.current = "";
    const off = onEvent((e) => {
      if (e.kind === "browser.state" && isBrowserEventFor(e, sessionId, viewerId) && !subscribed.current) {
        subscribed.current = true;
        scheduleResize(100);
      }
    });
    return off;
  }, [sessionId, viewerId, onEvent, scheduleResize, epoch]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      draw();
      scheduleResize();
    });
    ro.observe(stage);
    return () => {
      ro.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [draw, scheduleResize]);

  // ------------------------------------------------------------------ input

  /** Map a pointer event to page CSS pixels; null when outside the drawn image. */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const { width, height } = frame.current;
    const r = drawn.current;
    if (!canvas || !r.w || !r.h || !width || !height) return null;
    const box = canvas.getBoundingClientRect();
    return toPagePoint({ x: clientX - box.left, y: clientY - box.top }, r, { width, height });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastMove = 0;
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    let queued: { x: number; y: number } | null = null;

    const flushMove = () => {
      moveTimer = null;
      if (queued) {
        send({ type: "mouse", action: "move", ...queued });
        lastMove = Date.now();
        queued = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      queued = p;
      const wait = 30 - (Date.now() - lastMove);
      if (wait <= 0) flushMove();
      else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
    };
    const onButton = (action: "down" | "up") => (e: MouseEvent) => {
      const p = toPage(e.clientX, e.clientY);
      if (action === "down") canvas.focus();
      if (!p) return;
      e.preventDefault();
      if (queued) flushMove();
      send({ type: "mouse", action, ...p, button: BUTTONS[e.button] ?? "left", clickCount: Math.max(1, e.detail) });
    };
    const onDown = onButton("down");
    const onUp = onButton("up");
    const onWheel = (e: WheelEvent) => {
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
      send({ type: "mouse", action: "wheel", ...p, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    const onPaste = (e: ClipboardEvent) => {
      if (document.activeElement !== canvas) return;
      const text = e.clipboardData?.getData("text/plain");
      if (text) {
        e.preventDefault();
        send({ type: "text", text });
      }
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    document.addEventListener("paste", onPaste);
    return () => {
      if (moveTimer) clearTimeout(moveTimer);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      document.removeEventListener("paste", onPaste);
    };
  }, [send, toPage]);

  const onKey = (action: "down" | "up") => (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const k = e.key.toLowerCase();
    // ⌘V is delivered as a paste event (with the clipboard text) instead of a key press.
    if (e.metaKey && k === "v") return;
    // The app's own ⌘ chords (⇧⌘] next tab, ⌥⌘← another pane, ⌘K, ⌘W…) never reach the page.
    if (isAppChord(e)) return;
    const modifiers = modifiersOf(e);
    const input: BrowserInput = { type: "key", action, key: e.key, code: e.code, modifiers };
    if (action === "down" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.text = e.key;
    send(input);
    // Let other ⌘-shortcuts (⌘R, ⌘W, ⌘N…) reach the app; editing combos belong to the page.
    if (!e.metaKey || PAGE_META_KEYS.has(k) || e.key === "Meta") e.preventDefault();
  };

  // ------------------------------------------------------------------ toolbar

  const navigate = async () => {
    const url = normalizeUrl(urlDraft);
    if (!url) return;
    setUrlDraft(url);
    editingUrl.current = false;
    (document.activeElement as HTMLElement | null)?.blur();
    const tab = viewTab.current;
    const next = await act(() => client.browserNavigate(sessionId, url, typeof tab === "number" ? tab : undefined));
    if (next && (next.tabId === undefined || viewTab.current === undefined || next.tabId === viewTab.current)) applyState(next);
  };

  // ------------------------------------------------------------------ tabs

  const tabs = state?.tabs;
  const expectState = (accepts: (s: BrowserState) => boolean) => {
    expecting.current = { accepts, until: Date.now() + 3000 };
  };

  const switchTab = (tab: BrowserTab) => {
    if (tab.id === viewTab.current) return;
    clearFrame();
    viewTab.current = tab.id;
    expectState(confirmsSwitch(tab.id));
    // Show the tab's url and title right away (over an edit in progress, which was the other
    // tab's); its browser.state and last frame follow.
    editingUrl.current = false;
    setUrlDraft(tab.url);
    setState((s) => s && { ...s, tabId: tab.id, url: tab.url, title: tab.title, loading: tab.loading });
    socket.subscribeBrowser(sessionId, tab.id, viewerId);
  };

  const newTab = () => {
    // The service moves this viewer to the new tab; its id comes with the next browser.state.
    clearFrame();
    viewTab.current = "pending";
    expectState(confirmsNewTab(tabs ?? []));
    socket.send({ type: "browser.input", sessionId, viewerId, input: { type: "newTab" } });
    setUrlDraft("");
    urlInputRef.current?.focus();
  };

  const closeTab = (tab: BrowserTab) => {
    // Closing the shown tab moves this socket to the lowest open one (or a fresh blank tab).
    if (tab.id === viewTab.current) {
      clearFrame();
      viewTab.current = "pending";
      expectState(confirmsClose(tab.id));
    }
    setState((s) => s && { ...s, tabs: s.tabs?.filter((t) => t.id !== tab.id) });
    socket.send({ type: "browser.input", sessionId, viewerId, tabId: tab.id, input: { type: "closeTab" } });
  };

  /** Arrow keys move between tabs (and switch to them), like a native tab list. */
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!tabs) return;
    const to = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    const tab = tabs[to];
    if (!tab) return;
    e.preventDefault();
    switchTab(tab);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${tab.id}"]`)?.focus();
  };

  const empty = !hasFrame && !state;
  const pinned = pinnedTab !== undefined;
  /** The shown tab, when it's torn off into a pane or window of its own (it shows there, not here). */
  const tornShown = !pinned && tear && typeof state?.tabId === "number" ? tear.torn.get(`browser:${state.tabId}`) : undefined;
  const chipDrag = (tab: BrowserTab): TabDrag => ({ kind: "tab", ticketKey: tear!.ticketKey, tab: "browser", browserTab: tab.id });

  /** Freeze the page as it is now (a screenshot from the service) and annotate that. */
  const annotatePage = async () => {
    if (!annotator || shooting) return;
    const tabId = typeof viewTab.current === "number" ? viewTab.current : state?.tabId;
    setShooting(true);
    await settleSize();
    const shot = await act(() => client.browserScreenshot(sessionId, tabId));
    setShooting(false);
    if (!shot) return;
    annotator.open({
      name: shot.title || shot.url,
      page: { url: shot.url, title: shot.title, tabId: shot.tabId, viewport: shot.viewport, scale: shot.scale },
      load: async () => new Blob([Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0))], { type: "image/png" }),
      // The screenshot as it is, uploaded once the notes are added (a frozen page closed unannotated leaves nothing behind).
      attachment: (png) => client.uploadAttachment(png, `${browserShotName(shot.url, shot.title)}.png`, "image/png"),
      // What each mark points at, in the page as it was captured (null once the tab has moved on).
      // An older service sends no scroll, and has no lookup either.
      ...(shot.scroll
        ? { elementAt: (x: number, y: number) => client.browserElementAt(sessionId, { tabId: shot.tabId, x, y, url: shot.url, scroll: shot.scroll, viewport: shot.viewport }) }
        : {}),
    });
  };

  return (
    <div className="browser">
      {!pinned && tabs && tabs.length > 1 && (
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs" ref={tabsRef}>
          {tabs.map((tab, i) => {
            const label = tabLabel(tab);
            const on = tab.id === state?.tabId;
            const torn = tear?.torn.get(`browser:${tab.id}`);
            return (
              <div key={tab.id} className={`browser-tab ${on ? "on" : ""} ${tab.suspended && !on ? "suspended" : ""} ${torn ? "torn" : ""}`} role="presentation">
                <button
                  className="browser-tab-select"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  data-tab-id={tab.id}
                  title={tabTooltip(tab) + (tear ? "\nDrag off to open it in a pane of its own" : "")}
                  onClick={() => switchTab(tab)}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  {...(tear && {
                    ...dragProps(chipDrag(tab), { chip: tear.ticketKey, title: label, tab: "Browser" }, tear.boardScope),
                    onContextMenu: (e) => void tabContextMenu(e, tear.scope, tear.boardScope, tear.paneId, chipDrag(tab), torn),
                  })}
                >
                  {tab.loading ? <span className="spinner browser-tab-spinner" /> : <Icon name="globe" size={11} className="browser-tab-icon" />}
                  <span className="truncate">{label}</span>
                  {torn && <TornMark torn={torn} />}
                </button>
                <button className="browser-tab-close" title="Close tab" aria-label={`Close ${label}`} onClick={() => closeTab(tab)}>
                  <Icon name="x" size={11} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="browser-bar">
        <button className="btn btn-ghost btn-icon btn-sm" title="Back" disabled={empty} onClick={() => send({ type: "back" })}>
          <Icon name="chevronLeft" />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" title="Forward" disabled={empty} onClick={() => send({ type: "forward" })}>
          <Icon name="chevronRight" />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" title="Reload" disabled={empty} onClick={() => send({ type: "reload" })}>
          {state?.loading ? <span className="spinner" /> : <Icon name="refresh" />}
        </button>
        <div className="browser-url" title={state?.title || undefined}>
          <Icon name="globe" size={12} className="browser-url-icon" />
          <input
            ref={urlInputRef}
            className="browser-url-input mono"
            value={urlDraft}
            placeholder="Enter a URL…"
            spellCheck={false}
            onFocus={(e) => {
              editingUrl.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              editingUrl.current = false;
              setUrlDraft(state?.url ?? urlDraft);
            }}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void navigate();
              if (e.key === "Escape") {
                setUrlDraft(state?.url ?? "");
                e.currentTarget.blur();
              }
            }}
          />
          {state?.title && <span className="browser-title truncate">{state.title}</span>}
        </div>
        {tabs && !pinned && (
          <button className="btn btn-ghost btn-icon btn-sm" title="New tab" aria-label="New tab" data-testid="browser-new-tab" onClick={newTab}>
            <Icon name="plus" />
          </button>
        )}
        {annotator && (
          <button
            className="btn btn-ghost btn-sm"
            data-testid="browser-annotate"
            title="Freeze this page and number spots on it for your message"
            disabled={!hasFrame || shooting || viewTab.current === "pending"}
            onClick={() => void annotatePage()}
          >
            {shooting ? <span className="spinner" /> : <Icon name="edit" />} Annotate
          </button>
        )}
        <span className={`browser-live ${live ? "on" : ""}`} title={live ? "Receiving frames" : "Idle"}>
          <span className="browser-live-dot" />
          {live ? "Live" : "Idle"}
        </span>
      </div>
      <div className="browser-stage" ref={stageRef}>
        <canvas ref={canvasRef} className="browser-canvas" tabIndex={0} onKeyDown={onKey("down")} onKeyUp={onKey("up")} />
        {empty && (
          <div className="browser-empty empty">
            <Icon name="globe" />
            <strong>No browser yet</strong>
            <span>When the agent opens a page it appears here. You can also enter a URL above.</span>
          </div>
        )}
        {!empty && !hasFrame && !tornShown && (
          <div className="browser-empty empty">
            <span className="spinner" />
            <span>Waiting for the first frame…</span>
          </div>
        )}
        {tornShown && tear && (
          <div className="browser-empty browser-torn">
            <TornPlaceholder name={state?.title ? `“${tabLabel({ title: state.title, url: state.url ?? "" })}”` : "This tab"} torn={tornShown} onReturn={() => returnTabPane(tear.boardScope, tear.ticketKey, `browser:${tornShown.content.browserTab}`)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A tab size as the pane compares them: whole CSS pixels. */
function sizeKey(width: number, height: number): string {
  return `${Math.round(width)}x${Math.round(height)}`;
}
