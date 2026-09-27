// Keep a scroller at the bottom while the user is there (see nextPinned in shared state).
// A ResizeObserver on the scroller and its children catches every way the content or the
// viewport can change size: new entries, streaming text, images loading, window resizes,
// a growing composer. It runs after layout and before paint, so there's no visible jump.

import { useLayoutEffect, useRef } from "react";
import { nextPinned } from "@harness/shared/state";

export function useStickToBottom<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };
    const resize = new ResizeObserver(follow);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
    };
    const children = new MutationObserver(observeChildren);
    const onScroll = () => {
      pinned.current = nextPinned(pinned.current, lastTop.current, { offset: el.scrollTop, contentHeight: el.scrollHeight, viewportHeight: el.clientHeight });
      lastTop.current = el.scrollTop;
    };
    observeChildren();
    children.observe(el, { childList: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    follow();
    return () => {
      resize.disconnect();
      children.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return ref;
}
