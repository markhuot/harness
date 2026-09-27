// Keep a ScrollView or FlatList at the bottom while the user is there (see nextPinned in shared
// state). Spread the returned props onto the list. Follows content growth (new rows, streaming
// text, FlatList measuring rows it had estimated) and viewport changes (keyboard, composer), and
// never pulls the view out from under a finger that's still dragging.
//
// Only a gesture (a drag, the momentum after it, a status-bar tap) can unpin or re-pin. UIKit
// and FlatList move the offset on their own too: when the viewport changes height while a list
// lays out, iOS nudges the offset up with no finger down, and reading that as the user
// scrolling away is what left the transcript stranded mid-list.

import { useRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { nextPinned } from "@harness/shared/state";

interface ScrollsToEnd {
  scrollToEnd(opts?: { animated?: boolean }): void;
}
/** A ScrollView, or a FlatList (which wraps one). */
interface Scrollable extends ScrollsToEnd {
  getNativeScrollRef?(): unknown;
}

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

export function useStickToBottom<T extends Scrollable>() {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  /** Finger on the list: don't move it. */
  const dragging = useRef(false);
  /** A drag or its momentum is under way: scroll events are the user's. */
  const gesture = useRef(false);
  const lastOffset = useRef(0);

  const follow = () => {
    if (!pinned.current || dragging.current || !ref.current) return;
    // FlatList.scrollToEnd aims at estimated row frames and ignores the content container's
    // bottom padding, so it lands short; the underlying ScrollView's goes to the real end.
    const native = ref.current.getNativeScrollRef?.() as Partial<ScrollsToEnd> | null | undefined;
    (native?.scrollToEnd ? (native as ScrollsToEnd) : ref.current).scrollToEnd({ animated: false });
  };
  const track = (e: ScrollEvent) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    if (gesture.current) pinned.current = nextPinned(pinned.current, lastOffset.current, { offset: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height });
    lastOffset.current = contentOffset.y;
  };
  const settle = (e: ScrollEvent) => {
    track(e);
    if (!gesture.current) return; // iOS also reports momentum end after a programmatic jump
    gesture.current = false;
    follow();
  };

  return {
    ref,
    scrollEventThrottle: 32,
    onScroll: track,
    onScrollBeginDrag: (e: ScrollEvent) => {
      dragging.current = true;
      gesture.current = true;
      track(e);
    },
    onScrollEndDrag: (e: ScrollEvent) => {
      dragging.current = false;
      track(e);
      // No velocity means no momentum phase follows, so the gesture is over now.
      if (!e.nativeEvent.velocity?.y) settle(e);
    },
    onMomentumScrollBegin: () => {
      gesture.current = true;
    },
    onMomentumScrollEnd: settle,
    onScrollToTop: () => {
      pinned.current = false;
    },
    onContentSizeChange: (_w: number, _h: number) => follow(),
    onLayout: (_e: LayoutChangeEvent) => follow(),
  };
}
