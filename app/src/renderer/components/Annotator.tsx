// The annotator (DESIGN.md "Annotations"): an image (a spec image, a prompt attachment, a file sent
// with a message, a frozen browser page, or a file waiting in the composer or a New session) with
// numbered notes drawn on it. Pressing on the image sets an anchor and dragging pulls out an arrow
// whose head points at it; a plain click numbers the spot itself. Each number gets its own message
// in the list beside the image (never over it). Add to message burns the arrows and numbers into
// the picture, uploads it, and hands it with its notes to a message being written: annotations
// never go to the agent on their own, the human sends them with the message they write.
//
// AnnotateScope sets where Add to message goes by default (a ticket's composer) and offers
// Annotate inside it (useAnnotate). A target can name its own destination (a file waiting in the
// composer or a New session is replaced in place).

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MAX_ANNOTATION_MARKS, type AnnotationSource } from "@harness/shared";
import { annotationStyle, fitRect, hitTestMarks, isAnnotationDrag, marksForMessage, moveMark, removeMark, setMarkMessage, toUnit, type DraftMark, type MarkHit, type Point } from "@harness/shared/state";
import { useStore } from "../state/store";
import { annotatedName, emptyHistory, encodeWithinLimit, endRun, hasAnnotatorWork, recordChange, sourceBaseName, undo, type AnnotatedImage, type AnnotatedOriginal, type AnnotatorSnapshot } from "../state/annotator";
import { rememberPreview } from "./PromptAttachments";
import { accentColor, drawAnnotations } from "./annotationDraw";
import { Icon } from "./Icon";
import { MOD, Modal } from "./bits";
import "./annotator.css";

/** An image to annotate: where it came from (kept with the notes), how to read its bytes, and where the result goes. */
export interface AnnotateTarget {
  /** Shown in the header. */
  name: string;
  /** The annotated file is `annotated-<base>.png`; default: the source's name without its extension. */
  baseName?: string;
  source: AnnotationSource;
  load: () => Promise<Blob>;
  /** Marks to start with (reopening a picture annotated earlier, over its original). */
  initialMarks?: DraftMark[];
  /** Where Add to message puts the picture; default: the scope's (the ticket's composer). Throws to keep the annotator open. */
  onAdd?: (image: AnnotatedImage) => void;
}

/** What a lightbox item offers Annotate with: where it came from, the original to reopen (its marks), and where the result goes. */
export interface AnnotateOffer {
  source: AnnotationSource;
  original?: AnnotatedOriginal;
  onAdd?: (image: AnnotatedImage) => void;
}

/** A target read from a URL (the service's, with the token in the query, or a blob: preview), or from the offer's original. */
export function offerTarget(url: string, name: string, offer: AnnotateOffer): AnnotateTarget {
  const { original } = offer;
  return {
    name,
    source: offer.source,
    onAdd: offer.onAdd,
    initialMarks: original?.marks,
    load: original
      ? async () => original.blob
      : async () => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(res.status === 404 ? "The image is gone" : `HTTP ${res.status}`);
          return res.blob();
        },
  };
}

interface AnnotateScopeValue {
  open: (t: AnnotateTarget) => void;
}

const AnnotateContext = createContext<AnnotateScopeValue | null>(null);

/** The annotator, or null where Annotate isn't offered. */
export function useAnnotate(): AnnotateScopeValue | null {
  return useContext(AnnotateContext);
}

/** Offers Annotate to everything inside; `onAdd` takes the pictures of targets that don't name their own destination. */
export function AnnotateScope({ onAdd, children }: { onAdd?: (image: AnnotatedImage) => void; children: ReactNode }) {
  const [target, setTarget] = useState<{ t: AnnotateTarget; n: number } | null>(null);
  const opened = useRef(0);
  const value = useMemo<AnnotateScopeValue>(() => ({ open: (t) => setTarget({ t, n: ++opened.current }) }), []);
  const fallback = useRef(onAdd);
  fallback.current = onAdd;
  return (
    <AnnotateContext.Provider value={value}>
      {children}
      {target && (
        <Annotator
          key={target.n}
          target={target.t}
          onClose={() => setTarget(null)}
          onAdd={(image) => {
            const to = target.t.onAdd ?? fallback.current;
            if (!to) throw new Error("There's no message to add it to");
            to(image);
            setTarget(null);
          }}
        />
      )}
    </AnnotateContext.Provider>
  );
}

type Drag = { kind: "new"; start: Point } | { kind: "move"; hit: MarkHit; start: Point; before: AnnotatorSnapshot; moved: boolean };

const isTextField = (el: Element | null) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox") || (el instanceof HTMLElement && el.isContentEditable);

function Annotator({ target, onClose, onAdd }: { target: AnnotateTarget; onClose: () => void; onAdd: (image: AnnotatedImage) => void }) {
  const { client, toast } = useStore();
  /** The image as loaded (kept as the original, to reopen with the marks) and decoded. */
  const [image, setImage] = useState<{ blob: Blob; bitmap: ImageBitmap } | null>(null);
  const bitmap = image?.bitmap ?? null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialMarks] = useState<DraftMark[]>(() => target.initialMarks ?? []);
  const [marks, setMarks] = useState<DraftMark[]>(initialMarks);
  // ⌘Z's steps; nothing on screen shows them, so a ref.
  const history = useRef(emptyHistory());
  const [selected, setSelected] = useState<number | null>(null);
  /** The arrow being pulled out (fractions of the image), once the press has moved far enough. */
  const [live, setLive] = useState<{ anchor: Point; tail: Point } | null>(null);
  const [adding, setAdding] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fields = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focusAfter = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const color = useMemo(accentColor, []);
  // Pointer and key handlers read the latest state.
  const cur = useRef<AnnotatorSnapshot>({ marks });
  cur.current = { marks };

  const canAdd = !!bitmap && marks.length > 0 && !adding;

  // ------------------------------------------------------------------ loading and layout

  useEffect(() => {
    let live = true;
    let loaded: ImageBitmap | null = null;
    // Bytes, not an <img>: an image from another origin drawn to a canvas would taint it.
    target
      .load()
      .then(async (blob) => ({ blob, bitmap: await createImageBitmap(blob) }))
      .then(
        (img) => {
          loaded = img.bitmap;
          if (live) setImage(img);
          else img.bitmap.close();
        },
        (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
      loaded?.close();
    };
  }, [target]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setBox({ w: stage.clientWidth, h: stage.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const fit = useMemo(() => {
    if (!bitmap) return { x: 0, y: 0, w: 0, h: 0 };
    // Never blown up past one image pixel per point.
    const r = fitRect(Math.min(box.w, bitmap.width), Math.min(box.h, bitmap.height), bitmap.width, bitmap.height);
    return { ...r, w: Math.max(1, Math.floor(r.w)), h: Math.max(1, Math.floor(r.h)) };
  }, [bitmap, box]);

  // ------------------------------------------------------------------ drawing

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(fit.w * dpr);
    const ph = Math.round(fit.h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, fit.w, fit.h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, fit.w, fit.h);
    const shown = live ? [...marks, { anchor: live.anchor, tail: live.tail, message: "" }] : marks;
    drawAnnotations(ctx, shown, fit.w, fit.h, { color, selected });
  }, [bitmap, fit, marks, live, selected, color]);

  // A new mark's field takes the focus once it's rendered.
  useEffect(() => {
    if (focusAfter.current === null) return;
    const el = fields.current[focusAfter.current];
    focusAfter.current = null;
    el?.focus();
  }, [marks]);

  // ------------------------------------------------------------------ changes

  /** Apply a change, remembering the state before it for ⌘Z. */
  const change = useCallback((next: AnnotatorSnapshot, key: string | null = null) => {
    history.current = recordChange(key === null ? endRun(history.current) : history.current, cur.current, key);
    setMarks(next.marks);
  }, []);

  const remove = useCallback(
    (i: number) => {
      change({ marks: removeMark(cur.current.marks, i) });
      setSelected(null);
    },
    [change],
  );

  const undoLast = useCallback(() => {
    const u = undo(history.current);
    if (!u) return;
    history.current = u.history;
    setMarks(u.state.marks);
    setSelected(null);
  }, []);
  const endTyping = () => void (history.current = endRun(history.current));

  const focusField = (i: number) => {
    setSelected(i);
    fields.current[i]?.focus();
  };

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const requestClose = useCallback(() => {
    if (adding) return;
    if (hasAnnotatorWork(cur.current.marks, initialMarks) && !confirm("Discard these annotations?")) return;
    onClose();
  }, [onClose, adding, initialMarks]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = isTextField(document.activeElement);
      if (e.key === "z" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && !typing) {
        e.preventDefault();
        e.stopPropagation();
        undoLast();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !typing && !e.metaKey && selectedRef.current !== null) {
        e.preventDefault();
        e.stopPropagation();
        remove(selectedRef.current);
      }
    };
    // Capture: ahead of the app's own shortcuts.
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, [undoLast, remove]);

  // ------------------------------------------------------------------ pointer

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const unit = (p: Point) => toUnit(p, fit.w, fit.h);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !bitmap || adding) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Off any message field, so Delete and ⌘Z act on the marks.
    e.currentTarget.focus();
    const p = local(e);
    const hit = hitTestMarks(cur.current.marks, p, fit.w, fit.h, annotationStyle(fit.w, fit.h));
    if (hit) {
      setSelected(hit.index);
      drag.current = { kind: "move", hit, start: p, before: cur.current, moved: false };
    } else {
      drag.current = { kind: "new", start: p };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const p = local(e);
    if (!d) {
      // Hover: a grab hand over a mark that a press would move.
      const over = hitTestMarks(cur.current.marks, p, fit.w, fit.h, annotationStyle(fit.w, fit.h));
      e.currentTarget.style.cursor = over ? "grab" : "crosshair";
      return;
    }
    if (d.kind === "move") {
      if (!d.moved && !isAnnotationDrag(d.start, p)) return;
      d.moved = true;
      e.currentTarget.style.cursor = "grabbing";
      setMarks(moveMark(d.before.marks, d.hit, unit(p)));
    } else {
      setLive(isAnnotationDrag(d.start, p) ? { anchor: unit(d.start), tail: unit(p) } : null);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    setLive(null);
    if (!d) return;
    const p = local(e);
    if (d.kind === "move") {
      if (d.moved) history.current = recordChange(endRun(history.current), d.before);
      else focusField(d.hit.index);
      return;
    }
    const list = cur.current.marks;
    if (list.length >= MAX_ANNOTATION_MARKS) {
      toast(`An image takes up to ${MAX_ANNOTATION_MARKS} notes.`, "error");
      return;
    }
    const mark: DraftMark = { anchor: unit(d.start), tail: isAnnotationDrag(d.start, p) ? unit(p) : null, message: "" };
    change({ marks: [...list, mark] });
    setSelected(list.length);
    focusAfter.current = list.length;
  };

  const onPointerCancel = () => {
    const d = drag.current;
    drag.current = null;
    setLive(null);
    if (d?.kind === "move" && d.moved) setMarks(d.before.marks);
  };

  // ------------------------------------------------------------------ add to message

  const add = async () => {
    if (!canAdd || !image) return;
    setAdding(true);
    try {
      const W = image.bitmap.width;
      const H = image.bitmap.height;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image.bitmap, 0, 0);
      drawAnnotations(ctx, marks, W, H, { color });
      const blob = await encodeWithinLimit(async (type, quality) => {
        if (type === "image/png") return canvas.convertToBlob({ type });
        // JPEG has no transparency: what's see-through goes on white, not black.
        const flat = new OffscreenCanvas(W, H);
        const fctx = flat.getContext("2d")!;
        fctx.fillStyle = "#fff";
        fctx.fillRect(0, 0, W, H);
        fctx.drawImage(canvas, 0, 0);
        return flat.convertToBlob({ type, quality });
      });
      const name = annotatedName(target.baseName ?? sourceBaseName(target.source), blob.type);
      const attachment = await client.uploadPromptAttachment(blob, name, blob.type);
      // The row shows the picture at once, without a round trip.
      rememberPreview(attachment.path, blob);
      onAdd({
        attachment,
        annotation: { source: target.source, width: W, height: H, marks: marksForMessage(marks, W, H) },
        original: { blob: image.blob, marks },
      });
    } catch (e) {
      toast(`Couldn't add the annotations: ${e instanceof Error ? e.message : String(e)}`, "error");
      setAdding(false);
    }
  };

  const addKeys = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    }
  };

  return (
    <Modal onClose={requestClose} className="annotator">
      <div className="annotator-body" data-testid="annotator">
        <div className="annotator-stage" ref={stageRef}>
          {loadError ? (
            <div className="annotator-error">
              <Icon name="alert" size={16} />
              <span>Couldn't load the image: {loadError}</span>
            </div>
          ) : !bitmap ? (
            <span className="spinner" />
          ) : (
            <canvas
              ref={canvasRef}
              className="annotator-canvas"
              data-testid="annotator-canvas"
              tabIndex={0}
              aria-label={`${target.name}: click to number a spot, drag to point an arrow at it`}
              style={{ width: fit.w, height: fit.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          )}
        </div>
        <aside className="annotator-side" data-testid="annotator-side">
          <header className="annotator-head">
            <strong>Annotate</strong>
            <span className="muted truncate" title={target.name}>
              {target.name}
            </span>
            <div className="grow" />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close" title="Close (Esc)" onClick={requestClose}>
              <Icon name="x" />
            </button>
          </header>
          <p className="annotator-hint muted">Click to number a spot, or drag to point an arrow at it. Drag a number to move it.</p>
          {marks.length === 0 ? (
            <div className="annotator-empty muted">No notes yet</div>
          ) : (
            <ol className="annotator-list" data-testid="annotator-list" aria-label="Notes">
              {marks.map((m, i) => (
                <li key={i} className={`annotator-row${selected === i ? " on" : ""}`} data-testid="annotator-row" data-n={i + 1}>
                  <button type="button" className="annotator-badge" tabIndex={-1} aria-label={`Note ${i + 1}`} onClick={() => focusField(i)}>
                    {i + 1}
                  </button>
                  <textarea
                    ref={(el) => {
                      fields.current[i] = el;
                    }}
                    className="annotator-message"
                    data-testid="annotator-message"
                    rows={2}
                    placeholder={`What about ${i + 1}?`}
                    value={m.message}
                    disabled={adding}
                    onFocus={() => setSelected(i)}
                    onBlur={endTyping}
                    onChange={(e) => change({ marks: setMarkMessage(cur.current.marks, i, e.target.value) }, `message:${i}`)}
                    onKeyDown={addKeys}
                  />
                  <button type="button" className="annotator-remove" data-testid="annotator-remove" aria-label={`Delete note ${i + 1}`} title={`Delete note ${i + 1}`} onClick={() => remove(i)} disabled={adding}>
                    <Icon name="x" size={12} strokeWidth={2.25} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <footer className="annotator-foot">
            <span className="muted annotator-foot-hint">Added to your message with its notes, for you to say why and send.</span>
            <div className="annotator-actions">
              <button className="btn btn-sm" data-testid="annotator-cancel" onClick={requestClose} disabled={adding}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" data-testid="annotator-add" disabled={!canAdd} onClick={() => void add()} title={`Add to message (${MOD}↩)`}>
                {adding ? <span className="spinner" /> : <Icon name="plus" size={13} />}
                Add to message
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </Modal>
  );
}
