// The ticket screen's hero gets out of the way while a tab's body scrolls (lib/heroCollapse has the
// rules). The screen owns the state and provides it; a tab body spreads useHeroScroll(ownProps)
// onto its ScrollView or FlatList. Outside a ticket screen, useHeroScroll hands back its own props.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { LayoutAnimation, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { collapseStep, SHOWN, type Collapse, type CollapseEvent } from "../lib/heroCollapse";

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

interface HeroScrollHandlers {
  onScrollBeginDrag(e: ScrollEvent): void;
  onScroll(e: ScrollEvent): void;
  onScrollEndDrag(e: ScrollEvent): void;
  onMomentumScrollEnd(e: ScrollEvent): void;
  onScrollToTop(e: ScrollEvent): void;
}

const Ctx = createContext<HeroScrollHandlers | null>(null);

const metrics = (e: ScrollEvent) => {
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
  return { offset: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height };
};

/**
 * The hero's state for a ticket screen: `hidden`, `show()` (another tab, news on the ticket),
 * `onHeroLayout` for the hero's wrapper, and `handlers` for the HeroScrollProvider around the tab
 * bodies.
 */
export function useHeroCollapse() {
  const [hidden, setHidden] = useState(false);
  const state = useRef<Collapse>(SHOWN);
  const heroHeight = useRef(0);

  const step = useCallback((e: CollapseEvent) => {
    const prev = state.current;
    const next = collapseStep(prev, e, heroHeight.current);
    state.current = next;
    if (next.hidden === prev.hidden) return;
    LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setHidden(next.hidden);
  }, []);

  const handlers = useMemo<HeroScrollHandlers>(
    () => ({
      onScrollBeginDrag: (e) => step({ type: "beginDrag", ...metrics(e) }),
      onScroll: (e) => step({ type: "scroll", ...metrics(e) }),
      onScrollEndDrag: (e) => step({ type: "endDrag", velocity: e.nativeEvent.velocity?.y ?? 0 }),
      onMomentumScrollEnd: () => step({ type: "momentumEnd" }),
      onScrollToTop: () => step({ type: "show" }),
    }),
    [step],
  );

  const show = useCallback(() => step({ type: "show" }), [step]);
  // Measured while shown: it's how much room hiding it gives the tab body.
  const onHeroLayout = useCallback((height: number) => {
    if (!state.current.hidden) heroHeight.current = height;
  }, []);
  return { hidden, show, onHeroLayout, handlers };
}

/** Around a ticket screen's tab bodies, with useHeroCollapse().handlers. */
export const HeroScrollProvider = Ctx.Provider;

/** A tab body's scroll props with the hero's handlers chained after its own. */
export function useHeroScroll<P extends Partial<HeroScrollHandlers> & { scrollEventThrottle?: number }>(own: P = {} as P): P {
  const hero = useContext(Ctx);
  if (!hero) return own;
  const merged: Record<string, unknown> = { ...own, scrollEventThrottle: own.scrollEventThrottle ?? 32 };
  for (const key of Object.keys(hero) as (keyof HeroScrollHandlers)[]) {
    const mine = own[key] as ((e: ScrollEvent) => void) | undefined;
    merged[key] = (e: ScrollEvent) => {
      mine?.(e);
      hero[key](e);
    };
  }
  return merged as P;
}
