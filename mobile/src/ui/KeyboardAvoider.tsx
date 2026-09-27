// Drop-in for KeyboardAvoidingView behavior="padding" that measures itself in window
// coordinates, so screens under a navigation header and inside sheets clear the whole keyboard
// (see lib/keyboard). Children can ask whether the keyboard is covering it with useKeyboardShown,
// e.g. to drop a home-indicator inset the keyboard now hides.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Keyboard, LayoutAnimation, View, type KeyboardEvent, type StyleProp, type ViewStyle } from "react-native";
import { keyboardOverlap, type KeyboardFrame } from "../lib/keyboard";

const Shown = createContext(false);

/** True while the keyboard covers the nearest KeyboardAvoider. */
export const useKeyboardShown = () => useContext(Shown);

export function KeyboardAvoider({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  const keyboard = useRef<KeyboardFrame | null>(null);
  const [bottom, setBottom] = useState(0);

  const measure = useCallback((e?: KeyboardEvent) => {
    ref.current?.measureInWindow((_x, y, _w, height) => {
      const next = keyboardOverlap({ y, height }, keyboard.current);
      setBottom((prev) => {
        if (prev === next) return prev;
        if (e?.duration) LayoutAnimation.configureNext({ duration: e.duration, update: { duration: e.duration, type: LayoutAnimation.Types[e.easing] ?? "keyboard" } });
        return next;
      });
    });
  }, []);

  useEffect(() => {
    const subs = [
      Keyboard.addListener("keyboardWillChangeFrame", (e) => {
        keyboard.current = e.endCoordinates;
        measure(e);
      }),
      Keyboard.addListener("keyboardWillHide", (e) => {
        keyboard.current = null;
        measure(e);
      }),
      // A sheet that autofocuses its input is still sliding up when the keyboard's will-show
      // fires; settle on where it ended up.
      Keyboard.addListener("keyboardDidShow", (e) => {
        keyboard.current = e.endCoordinates;
        measure();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [measure]);

  return (
    <View ref={ref} style={[style, { paddingBottom: bottom }]} onLayout={() => measure()}>
      <Shown.Provider value={bottom > 0}>{children}</Shown.Provider>
    </View>
  );
}
