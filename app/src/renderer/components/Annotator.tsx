// The annotator (DESIGN.md "Annotations"): an image attachment (a spec image, a New session's file,
// a file sent with a message, a frozen browser page, or a file waiting in the composer or a New
// session) with
// numbered notes drawn over it. Pressing on the image sets an anchor and dragging pulls out an arrow
// whose head points at it; a plain click numbers the spot itself. Each number gets its own message
// in the list beside the image (never over it). Add to message hands the attachment and its
// annotation (the marks in the image's pixels: metadata, the image is never changed) to a message
// being written: annotations never go to the agent on their own, the human sends them with the
// message they write.
//
// AnnotateScope sets where Add to message goes by default (a ticket's composer) and offers
// Annotate inside it (useAnnotate). A target can name its own destination (a file waiting in the
// composer or a New session is annotated in place).

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MAX_ANNOTATION_MARKS, type AnnotationPage, type Attachment, type AttachmentAnnotation, type BrowserElement } from "@harness/shared";
import { annotationStyle, draftMarksFrom, fitRect, hitTestMarks, isAnnotationDrag, moveMark, removeMark, setMarkElement, setMarkMessage, toUnit, type DraftMark, type MarkHit, type Point } from "@harness/shared/state";
import { useStore } from "../state/store";
import { anchorInPage, annotationFromMarks, elementLabel, emptyHistory, endRun, hasAnnotatorWork, recordChange, undo, type AnnotatorSnapshot } from "../state/annotator";
import { previewFile, rememberPreview } from "./PromptAttachments";
import { accentColor, drawAnnotations } from "./annotationDraw";
import { Icon } from "./Icon";
import { MOD, Modal } from "./bits";
import "./annotator.css";

/** What Add to message hands on: the attachment, and its notes (null: none, which takes them off). */
export interface AnnotatedAttachment {
  attachment: Attachment;
  annotation: AttachmentAnnotation | null;
}

/** An image to annotate: how to read its bytes, the attachment its notes go on, and where they go. */
export interface AnnotateTarget {
  /** Shown in the header. */
  name: string;
  load: () => Promise<Blob>;
  /**
   * The attachment the annotation goes on (a spec image, a waiting or sent file: the record with
   * its id); or, for an image that isn't a file yet (a browser screenshot), made from its bytes on
   * Add (uploaded then).
   */
  attachment: Attachment | ((image: Blob) => Promise<Attachment>);
  /** The browser page a screenshot shows. */
  page?: AnnotationPage;
  /**
   * A browser screenshot's: the element under a point of the page as it was captured (CSS pixels),
   * or null when the page has moved on. Each mark's anchor is looked up with it, so the agent is
   * told which element the mark points at.
   */
  elementAt?: (x: number, y: number) => Promise<BrowserElement | null>;
  /** The notes it has already: reopened to edit. */
  annotation?: AttachmentAnnotation;
  /** Where Add to message puts it; default: the scope's (the ticket's composer). Throws to keep the annotator open. */
  onAdd?: (a: AnnotatedAttachment) => void;
}

/** What a lightbox item offers Annotate with: its attachment (with the notes it has), and where the result goes. */
export interface AnnotateOffer {
  attachment: Attachment;
  onAdd?: (a: AnnotatedAttachment) => void;
}

/** A target read from a URL (the service's, with the token in the query), or a preview's own bytes. */
export function offerTarget(url: string, offer: AnnotateOffer): AnnotateTarget {
  const local = previewFile(url);
  return {
    name: offer.attachment.name,
    attachment: offer.attachment,
    annotation: offer.attachment.annotation,
    onAdd: offer.onAdd,
    load: async () => {
      if (local) return local;
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

/**
 * Offers Annotate to everything inside. `onAdd` takes the annotations of targets that don't name
 * their own destination; `annotationOf` says what notes that destination has on a file already
 * (one waiting in the composer), so annotating it again from anywhere edits those.
 */
export function AnnotateScope({ onAdd, annotationOf, children }: { onAdd?: (a: AnnotatedAttachment) => void; annotationOf?: (a: Attachment) => AttachmentAnnotation | undefined; children: ReactNode }) {
  const [target, setTarget] = useState<{ t: AnnotateTarget; n: number } | null>(null);
  const opened = useRef(0);
  const fallback = useRef({ onAdd, annotationOf });
  fallback.current = { onAdd, annotationOf };
  const value = useMemo<AnnotateScopeValue>(
    () => ({
      open: (t) => {
        const waiting = !t.onAdd && typeof t.attachment !== "function" ? fallback.current.annotationOf?.(t.attachment) : undefined;
        setTarget({ t: waiting ? { ...t, annotation: waiting } : t, n: ++opened.current });
      },
    }),
    [],
  );
  return (
    <AnnotateContext.Provider value={value}>
      {children}
      {target && (
        <Annotator
          key={target.n}
          target={target.t}
          onClose={() => setTarget(null)}
          onAdd={(a) => {
            const to = target.t.onAdd ?? fallback.current.onAdd;
            if (!to) throw new Error("There's no message to add it to");
            to(a);
            setTarget(null);
          }}
        />
      )}
    </AnnotateContext.Provider>
  );
}

type Drag = { kind: "new"; start: Point } | { kind: "move"; hit: MarkHit; start: Point; before: AnnotatorSnapshot; moved: boolean };

const isTextField = (el: Element | null) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox") || (el instanceof HTMLElement && el.isContentEditable);

function Annotator({ target, onClose, onAdd }: { target: AnnotateTarget; onClose: () => void; onAdd: (a: AnnotatedAttachment) => void }) {
  const { toast } = useStore();
  /** The image as loaded and decoded. */
  const [image, setImage] = useState<{ blob: Blob; bitmap: ImageBitmap } | null>(null);
  const bitmap = image?.bitmap ?? null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialMarks] = useState<DraftMark[]>(() => (target.annotation ? draftMarksFrom(target.annotation) : []));
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

  // Every mark of a reopened annotation deleted: Add takes its notes off.
  const canAdd = !!bitmap && !adding && (marks.length > 0 || initialMarks.length > 0);

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

  // ------------------------------------------------------------------ the element under a browser mark

  const lookups = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => () => lookups.current.forEach((t) => clearTimeout(t)), []);
  /**
   * Look up the element under mark `i`'s anchor (a browser screenshot only), shortly after it was
   * placed or moved: the latest placement wins, and an answer for an anchor that has moved on since
   * (or a mark deleted) is dropped. A failure leaves the mark without one.
   */
  const lookUpElement = (i: number) => {
    const elementAt = target.elementAt;
    const page = target.page;
    if (!elementAt || !page || !bitmap) return;
    const pending = lookups.current.get(i);
    if (pending) clearTimeout(pending);
    const { width, height } = bitmap;
    lookups.current.set(
      i,
      setTimeout(() => {
        lookups.current.delete(i);
        const anchor = cur.current.marks[i]?.anchor;
        if (!anchor) return;
        const p = anchorInPage(anchor, width, height, page.scale);
        elementAt(p.x, p.y).then(
          (el) => {
            const now = cur.current.marks;
            // Not in the undo history: it follows from where the anchor is.
            if (now[i]?.anchor === anchor) setMarks(setMarkElement(now, i, el ? { path: el.path, text: el.text } : null));
          },
          () => {},
        );
      }, 250),
    );
  };

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
      if (d.moved) {
        history.current = recordChange(endRun(history.current), d.before);
        // The anchor moved (a click's badge is its anchor): what it points at may be another element.
        if (cur.current.marks[d.hit.index]?.anchor !== d.before.marks[d.hit.index]?.anchor) lookUpElement(d.hit.index);
      } else focusField(d.hit.index);
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
    lookUpElement(list.length);
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
      const { width, height } = image.bitmap;
      const attachment = typeof target.attachment === "function" ? await target.attachment(image.blob) : target.attachment;
      // The row shows the picture at once, from the bytes in hand.
      rememberPreview(attachment.id, image.blob);
      onAdd({ attachment, annotation: annotationFromMarks(marks, width, height, target.page ?? target.annotation?.page) });
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
                  <div className="annotator-field">
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
                  {m.element && (
                    <span className="annotator-element muted mono truncate" data-testid="annotator-element" title={`The agent is told: ${elementLabel(m.element)}`}>
                      {elementLabel(m.element)}
                    </span>
                  )}
                  </div>
                  <button type="button" className="annotator-remove" data-testid="annotator-remove" aria-label={`Delete note ${i + 1}`} title={`Delete note ${i + 1}`} onClick={() => remove(i)} disabled={adding}>
                    <Icon name="x" size={12} strokeWidth={2.25} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <footer className="annotator-foot">
            <span className="muted annotator-foot-hint">Added to your message with its notes, for you to say why and send. The image itself isn't changed.</span>
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
