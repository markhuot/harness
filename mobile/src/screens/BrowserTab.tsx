// Live view of the session's headless Chrome tab. Screencast frames (base64 JPEG) are letterboxed
// into the stage and double-buffered so a new frame never flashes blank; touches become page
// mouse/wheel input (lib/browserInput); a hidden TextInput carries the keyboard. The page
// viewport follows the stage size, sent once the subscription is confirmed and only on change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import type { BrowserInput, BrowserState } from "@harness/shared";
import { fitRect, normalizeUrl, toPagePoint } from "@harness/shared/state";
import { keyPress, ResizeGate, textChangeInputs, TouchGesture } from "../lib/browserInput";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Empty, Spinner } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { haptic } from "../ui/haptics";

interface Frame {
  uri: string;
  width: number;
  height: number;
}

export function BrowserTab({ sessionId }: { sessionId: string }) {
  const { socket, client, onEvent, epoch } = useStore();
  const act = useAction();
  const c = useColors();
  const [bstate, setBState] = useState<BrowserState | null>(null);
  const [front, setFront] = useState<Frame | null>(null);
  const [back, setBack] = useState<Frame | null>(null);
  const [live, setLive] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [urlDraft, setUrlDraft] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [typing, setTyping] = useState(false);
  const lastFrameAt = useRef(0);
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = front;

  const send = useCallback((input: BrowserInput) => socket.send({ type: "browser.input", sessionId, input }), [socket, sessionId]);
  const sendAll = useCallback((inputs: BrowserInput[]) => inputs.forEach(send), [send]);

  // ------------------------------------------------------------------ subscription + frames
  const gate = useRef(new ResizeGate());
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const scheduleResize = useCallback(
    (ms = 250) => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        const r = gate.current.take(stageRef.current.w, stageRef.current.h);
        if (r) send(r);
      }, ms);
    },
    [send],
  );

  useEffect(() => {
    setBState(null);
    setFront(null);
    setBack(null);
    gate.current.reset();
    socket.subscribeBrowser(sessionId);
    const off = onEvent((e) => {
      if (e.kind === "browser.frame" && e.sessionId === sessionId) {
        lastFrameAt.current = Date.now();
        setLive(true);
        const mime = e.data.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        setBack({ uri: `data:${mime};base64,${e.data}`, width: e.width, height: e.height });
      } else if (e.kind === "browser.state" && e.sessionId === sessionId) {
        setBState(e.state);
        if (gate.current.confirm()) scheduleResize(100);
      }
    });
    return () => {
      off();
      socket.unsubscribeBrowser(sessionId);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [sessionId, socket, onEvent, scheduleResize, epoch]);

  useEffect(() => {
    let cancelled = false;
    client
      .browserState(sessionId)
      .then((s) => !cancelled && s && setBState(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, epoch]);

  useEffect(() => {
    if (!editingUrl) setUrlDraft(bstate?.url ?? "");
  }, [bstate?.url, editingUrl]);

  useEffect(() => {
    const t = setInterval(() => setLive(Date.now() - lastFrameAt.current < 2000), 500);
    return () => clearInterval(t);
  }, []);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setStage({ w: Math.round(width), h: Math.round(height) });
    stageRef.current = { w: Math.round(width), h: Math.round(height) };
    scheduleResize();
  };

  // ------------------------------------------------------------------ touch → page input
  const drawn = useMemo(() => (front ? fitRect(stage.w, stage.h, front.width, front.height) : { x: 0, y: 0, w: 0, h: 0 }), [front, stage]);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const gesture = useMemo(
    () =>
      new TouchGesture({
        toPage: (p) => {
          const f = frameRef.current;
          return f ? toPagePoint(p, drawnRef.current, f) : null;
        },
        scale: () => (frameRef.current && drawnRef.current.w ? frameRef.current.width / drawnRef.current.w : 1),
      }),
    [],
  );

  // Wheel events arrive at touch rate; coalesce them to ~30/s.
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushWheel = useCallback(() => {
    wheelTimer.current = null;
    const w = wheel.current;
    wheel.current = null;
    if (w && (w.dx || w.dy)) send({ type: "mouse", action: "wheel", x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy });
  }, [send]);
  const dispatchInputs = useCallback(
    (inputs: BrowserInput[]) => {
      for (const i of inputs) {
        if (i.type === "mouse" && i.action === "wheel") {
          const w = wheel.current ?? { x: i.x, y: i.y, dx: 0, dy: 0 };
          wheel.current = { x: i.x, y: i.y, dx: w.dx + (i.deltaX ?? 0), dy: w.dy + (i.deltaY ?? 0) };
          if (!wheelTimer.current) wheelTimer.current = setTimeout(flushWheel, 33);
        } else {
          if (wheel.current) flushWheel();
          send(i);
        }
      }
    },
    [send, flushWheel],
  );
  const pt = (e: GestureResponderEvent) => ({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  const now = () => Date.now();

  // ------------------------------------------------------------------ keyboard
  const input = useRef<TextInput>(null);
  const typed = useRef("");
  const onChangeText = (next: string) => {
    sendAll(textChangeInputs(typed.current, next));
    typed.current = next;
    if (next.length > 120) {
      input.current?.clear();
      typed.current = "";
    }
  };

  const navigate = async () => {
    const url = normalizeUrl(urlDraft);
    if (!url) return;
    setUrlDraft(url);
    setEditingUrl(false);
    const next = await act(() => client.browserNavigate(sessionId, url));
    if (next) setBState(next);
  };

  const empty = !front && !bstate;

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.bar, { borderBottomColor: c.border, backgroundColor: c.bgElev }]}>
        <BarButton icon="chevronLeft" label="Back" disabled={empty} onPress={() => send({ type: "back" })} />
        <BarButton icon="chevronRight" label="Forward" disabled={empty} onPress={() => send({ type: "forward" })} />
        <View style={[styles.url, { backgroundColor: c.bgSunken, borderColor: c.border }]}>
          <Icon name="globe" size={13} color={c.text3} />
          <TextInput
            value={urlDraft}
            onChangeText={setUrlDraft}
            onFocus={() => setEditingUrl(true)}
            onBlur={() => setEditingUrl(false)}
            onSubmitEditing={() => void navigate()}
            placeholder="Enter a URL…"
            placeholderTextColor={c.text3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
            style={{ flex: 1, color: c.text, fontSize: 14, fontFamily: MONO, paddingVertical: 6 }}
            accessibilityLabel="Address"
          />
          {bstate?.loading && <Spinner />}
        </View>
        <BarButton icon="refresh" label="Reload" disabled={empty} onPress={() => send({ type: "reload" })} />
        <BarButton
          icon="edit"
          label={typing ? "Hide keyboard" : "Type into the page"}
          active={typing}
          disabled={!front}
          onPress={() => (typing ? input.current?.blur() : input.current?.focus())}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 5 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live ? c.green : c.text3 }} />
        <Text style={{ color: c.text3, fontSize: 12 }}>{live ? "Live" : "Idle"}</Text>
        {!!bstate?.title && (
          <Text style={{ color: c.text2, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
            · {bstate.title}
          </Text>
        )}
      </View>
      <View
        style={[styles.stage, { backgroundColor: c.bgSunken }]}
        onLayout={onLayout}
        onStartShouldSetResponder={() => !!front}
        onMoveShouldSetResponder={() => !!front}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => dispatchInputs(gesture.begin(pt(e), now()))}
        onResponderMove={(e) => dispatchInputs(gesture.move(pt(e), now()))}
        onResponderRelease={(e) => {
          const out = gesture.end(pt(e), now());
          if (out.some((i) => i.type === "mouse" && i.action === "down")) haptic("tap");
          dispatchInputs(out);
        }}
        onResponderTerminate={() => dispatchInputs(gesture.cancel())}
        accessibilityLabel="Browser page. Tap to click, drag to scroll, hold then drag to select."
      >
        {front && <Image source={{ uri: front.uri }} fadeDuration={0} style={[styles.frame, { left: drawn.x, top: drawn.y, width: drawn.w, height: drawn.h }]} />}
        {back && back !== front && (
          <Image
            source={{ uri: back.uri }}
            fadeDuration={0}
            style={[styles.frame, { left: drawn.x, top: drawn.y, width: drawn.w || stage.w, height: drawn.h || stage.h, opacity: 0 }]}

            onLoad={() => setFront(back)}
          />
        )}
        {empty && (
          <View style={StyleSheet.absoluteFill}>
            <Empty icon="globe" title="No browser yet">
              When the agent opens a page it appears here. You can also enter a URL above.
            </Empty>
          </View>
        )}
        {!empty && !front && (
          <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", gap: 8 }]}>
            <Spinner />
            <Text style={{ color: c.text3 }}>Waiting for the first frame…</Text>
          </View>
        )}
      </View>
      <TextInput
        ref={input}
        style={styles.hidden}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        submitBehavior="submit"
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onChangeText={onChangeText}
        onSubmitEditing={() => sendAll(keyPress("Enter"))}
        onKeyPress={(e) => {
          const k = e.nativeEvent.key;
          if (k === "Tab") sendAll(keyPress("Tab"));
          else if (k === "Backspace" && typed.current === "") sendAll(keyPress("Backspace"));
        }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    </View>
  );
}

function BarButton({ icon, label, onPress, disabled, active }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; onPress: () => void; disabled?: boolean; active?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        haptic("tap");
        onPress();
      }}
      hitSlop={6}
      style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: active ? c.accentSoft : pressed ? c.bgActive : "transparent", opacity: disabled ? 0.35 : 1 })}
    >
      <Icon name={icon} size={17} color={active ? c.accentText : c.text2} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  url: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 9, paddingHorizontal: 9, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 4 },
  stage: { flex: 1, overflow: "hidden" },
  frame: { position: "absolute", pointerEvents: "none" },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
