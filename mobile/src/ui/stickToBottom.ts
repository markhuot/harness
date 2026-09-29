// Keep a ScrollView or FlatList at the bottom while the user is there (see nextPinned in shared
// state). Spread the returned props onto the list. Follows content growth (new rows, streaming
// text, FlatList measuring rows it had estimated) and viewport changes (keyboard, composer), and
// never pulls the view out from under a finger that's still dragging. Which events count is
// stickStep's call (lib/stickToBottom.ts).

import { useRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { stickStep, STUCK, type StickEvent } from "../lib/stickToBottom";

interface ScrollsToEnd {
  scrollToEnd(opts?: { animated?: boolean }): void;
}
/** A ScrollView, or a FlatList (which wraps one). */
interface Scrollable extends ScrollsToEnd {
  getNativeScrollRef?(): unknown;
}

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

const metrics = (e: ScrollEvent) => {
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
  return { offset: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height };
};

export function useStickToBottom<T extends Scrollable>() {
  const ref = useRef<T>(null);
  const stick = useRef(STUCK);

  const step = (e: StickEvent) => {
    const next = stickStep(stick.current, e);
    stick.current = next.stick;
    if (!next.follow || !ref.current) return;
    // FlatList.scrollToEnd aims at estimated row frames and ignores the content container's
    // bottom padding, so it lands short; the underlying ScrollView's goes to the real end.
    const native = ref.current.getNativeScrollRef?.() as Partial<ScrollsToEnd> | null | undefined;
    (native?.scrollToEnd ? (native as ScrollsToEnd) : ref.current).scrollToEnd({ animated: false });
  };

  return {
    ref,
    scrollEventThrottle: 32,
    onScroll: (e: ScrollEvent) => step({ type: "scroll", ...metrics(e) }),
    onScrollBeginDrag: (e: ScrollEvent) => step({ type: "beginDrag", ...metrics(e) }),
    onScrollEndDrag: (e: ScrollEvent) => step({ type: "endDrag", velocity: e.nativeEvent.velocity?.y ?? 0, ...metrics(e) }),
    onMomentumScrollBegin: () => step({ type: "momentumBegin" }),
    onMomentumScrollEnd: (e: ScrollEvent) => step({ type: "momentumEnd", ...metrics(e) }),
    onScrollToTop: () => step({ type: "scrollToTop" }),
    onContentSizeChange: (_w: number, _h: number) => step({ type: "resize" }),
    onLayout: (_e: LayoutChangeEvent) => step({ type: "resize" }),
  };
}
