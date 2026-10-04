// An attachment's annotation (DESIGN.md "Annotations") drawn over the image wherever it shows: a
// canvas laid over the thumbnail of an attachment row, or over the image in the lightbox. The image
// is untouched; its marks are metadata on the attachment, so they're drawn on top every time.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AttachmentAnnotation } from "@harness/shared";
import { draftMarksFrom } from "@harness/shared/state";
import { coverRect, thumbnailStyle, type Rect } from "../state/annotator";
import { accentColor, drawAnnotations } from "./annotationDraw";

function paint(canvas: HTMLCanvasElement, box: { w: number; h: number }, rect: Rect, annotation: AttachmentAnnotation, thumbnail: boolean) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.w * dpr));
  canvas.height = Math.max(1, Math.round(box.h * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.w, box.h);
  ctx.translate(rect.x, rect.y);
  drawAnnotations(ctx, draftMarksFrom(annotation), rect.w, rect.h, {
    color: accentColor(),
    ...(thumbnail ? { style: thumbnailStyle(Math.min(box.w, box.h)) } : {}),
  });
}

/** Over a thumbnail that covers its box (object-fit: cover): fills the positioned parent. */
export function ThumbnailAnnotation({ annotation }: { annotation: AttachmentAnnotation }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setBox({ w: parent.clientWidth, h: parent.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!ref.current || !box || !box.w || !box.h) return;
    paint(ref.current, box, coverRect(box.w, box.h, annotation.width, annotation.height), annotation, true);
  }, [box, annotation]);
  return <canvas ref={ref} className="annotation-overlay" data-testid="thumbnail-annotation" data-marks={annotation.marks.length} aria-hidden />;
}

/**
 * Over an <img> shown whole (the lightbox's, object-fit: contain with its own aspect), placed on the
 * image's box inside their shared positioned parent. Follows the image as the window resizes.
 */
export function ImageAnnotation({ annotation, img }: { annotation: AttachmentAnnotation; img: HTMLImageElement | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!img) return;
    const measure = () => setRect(img.complete && img.naturalWidth ? { x: img.offsetLeft, y: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight } : null);
    measure();
    img.addEventListener("load", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    if (img.parentElement) ro.observe(img.parentElement);
    return () => {
      img.removeEventListener("load", measure);
      ro.disconnect();
    };
  }, [img]);
  useEffect(() => {
    if (!ref.current || !rect || !rect.w || !rect.h) return;
    paint(ref.current, { w: rect.w, h: rect.h }, { x: 0, y: 0, w: rect.w, h: rect.h }, annotation, false);
  }, [rect, annotation]);
  if (!rect) return null;
  return (
    <canvas
      ref={ref}
      className="annotation-overlay"
      data-testid="lightbox-annotation"
      data-marks={annotation.marks.length}
      aria-hidden
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}
