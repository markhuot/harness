// Live view of a session's headless Chrome tab: screencast frames drawn onto a canvas,
// with mouse/keyboard input forwarded back to the page over the WebSocket.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BrowserInput, BrowserState } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { fitRect, normalizeUrl, toPagePoint, type Rect } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { isAppChord } from "../state/keys";
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

  const send = useCallback((input: BrowserInput) => socket.send({ type: "browser.input", sessionId, input }), [socket, sessionId]);

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
    // Frames are page CSS pixels; fit that page into the stage (with a little breathing room).
    const pad = 12;
    const r = fitRect(cw - pad * 2, ch - pad * 2, width || bitmap.width, height || bitmap.height);
    r.x += pad;
    r.y += pad;
    drawn.current = r;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
  }, []);

  const decode = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        const mime = next.data.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        try {
          // Decode via <img> (img-src data: is allowed by the CSP; fetch() of data: URLs isn't
          // reliable once webSecurity is on).
          const img = new Image();
          img.src = `data:${mime};base64,${next.data}`;
          await img.decode();
          const bitmap = await createImageBitmap(img);
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

  useEffect(() => {
    setState(null);
    setHasFrame(false);
    frame.current.bitmap?.close();
    frame.current = { bitmap: null, width: 0, height: 0 };
    draw();
    socket.subscribeBrowser(sessionId);
    const off = onEvent((e) => {
      if (e.kind === "browser.frame" && e.sessionId === sessionId) {
        debugStats.frames++;
        lastFrameAt.current = Date.now();
        setLive(true);
        pending.current = { data: e.data, width: e.width, height: e.height };
        void decode();
      } else if (e.kind === "browser.state" && e.sessionId === sessionId) {
        setState(e.state);
      }
    });
    return () => {
      off();
      socket.unsubscribeBrowser(sessionId);
    };
  }, [sessionId, socket, onEvent, decode, draw]);

  useEffect(() => {
    let cancelled = false;
    client
      .browserState(sessionId)
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, epoch]);

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
    const next = await act(() => client.browserNavigate(sessionId, url));
    if (next) setState(next);
  };

  const empty = !hasFrame && !state;

  return (
    <div className="browser">
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
