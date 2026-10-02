// Live view of a session's headless Chrome: the screencast frames of one of its tabs drawn onto a
// canvas, with mouse/keyboard input forwarded back to the page over the WebSocket. A strip above
// the bar switches between the session's tabs once it has more than one.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BrowserInput, BrowserState, BrowserTab } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { fitRect, normalizeUrl, toPagePoint, type Rect } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { isAppChord } from "../state/keys";
import { confirmsClose, confirmsNewTab, confirmsSwitch, frameIsForView, tabLabel, type ViewTab } from "../state/browserTabs";
import "./browser.css";

function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

/** Frame counters for tests/diagnostics (window.__harnessBrowser). */
const debugStats = { frames: 0, drawn: 0, errors: 0 };
(window as unknown as { __harnessBrowser: typeof debugStats }).__harnessBrowser = debugStats;
const PAGE_META_KEYS = new Set(["a", "c", "x", "z"]);


export function BrowserView({ sessionId }: { sessionId: string }) {
  const { socket, client, onEvent, epoch } = useStore();
  const act = useAction();
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

  const send = useCallback(
    (input: BrowserInput) => {
      const tab = viewTab.current;
      socket.send(typeof tab === "number" ? { type: "browser.input", sessionId, tabId: tab, input } : { type: "browser.input", sessionId, input });
    },
    [socket, sessionId],
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
      socket.noteBrowserTab(sessionId, s.tabId);
      setState(s);
    },
    [socket, sessionId, clearFrame],
  );

  useEffect(() => {
    setState(null);
    clearFrame();
    viewTab.current = undefined;
    expecting.current = null;
    socket.subscribeBrowser(sessionId);
    const off = onEvent((e) => {
      if (e.kind === "browser.frame" && e.sessionId === sessionId) {
        if (!frameIsForView(e.tabId, viewTab.current)) return;
        debugStats.frames++;
        lastFrameAt.current = Date.now();
        setLive(true);
        pending.current = { data: e.data, width: e.width, height: e.height };
        void decode();
      } else if (e.kind === "browser.state" && e.sessionId === sessionId) {
        applyState(e.state);
      }
    });
    return () => {
      off();
      socket.unsubscribeBrowser(sessionId);
    };
  }, [sessionId, socket, onEvent, decode, clearFrame, applyState]);

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
    const key = `${width}x${height}`;
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

  useEffect(() => {
    // New session or reconnect: the service-side subscription starts over.
    subscribed.current = false;
    lastSize.current = "";
    const off = onEvent((e) => {
      if (e.kind === "browser.state" && e.sessionId === sessionId && !subscribed.current) {
        subscribed.current = true;
        scheduleResize(100);
      }
    });
    return off;
  }, [sessionId, onEvent, scheduleResize, epoch]);

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
    // Show the tab's url and title right away; its browser.state (and last frame) follow.
    setState((s) => s && { ...s, tabId: tab.id, url: tab.url, title: tab.title, loading: tab.loading });
    socket.subscribeBrowser(sessionId, tab.id);
  };

  const newTab = () => {
    // The service moves this socket to the new tab; its id comes with the next browser.state.
    clearFrame();
    viewTab.current = "pending";
    expectState(confirmsNewTab(tabs ?? []));
    socket.send({ type: "browser.input", sessionId, input: { type: "newTab" } });
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
    socket.send({ type: "browser.input", sessionId, tabId: tab.id, input: { type: "closeTab" } });
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

  return (
    <div className="browser">
      {tabs && tabs.length > 1 && (
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs" ref={tabsRef}>
          {tabs.map((tab, i) => {
            const label = tabLabel(tab);
            const on = tab.id === state?.tabId;
            return (
              <div key={tab.id} className={`browser-tab ${on ? "on" : ""}`} role="presentation">
                <button
                  className="browser-tab-select"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  data-tab-id={tab.id}
                  title={tab.url && tab.url !== label ? `${label}\n${tab.url}` : label}
                  onClick={() => switchTab(tab)}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {tab.loading ? <span className="spinner browser-tab-spinner" /> : <Icon name="globe" size={11} className="browser-tab-icon" />}
                  <span className="truncate">{label}</span>
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
        {tabs && (
          <button className="btn btn-ghost btn-icon btn-sm" title="New tab" aria-label="New tab" data-testid="browser-new-tab" onClick={newTab}>
            <Icon name="plus" />
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
        {!empty && !hasFrame && (
          <div className="browser-empty empty">
            <span className="spinner" />
            <span>Waiting for the first frame…</span>
          </div>
        )}
      </div>
    </div>
  );
}
