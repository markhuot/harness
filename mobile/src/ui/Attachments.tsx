// Summary attachments: a row of thumbnails under a summary, and a full-screen viewer that pages
// between them (pinch to zoom images, native controls for video, swipe down or ✕ to close).
// Sizing, paging and swipe math live in lib/attachments.ts.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Animated, Image, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import type { SummaryAttachment } from "@harness/shared";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { RADIUS } from "../theme/tokens";
import { clampPage, dismissOnRelease, fitSize, formatSize, pageAt, pullOf, thumbSize } from "../lib/attachments";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

const label = (a: SummaryAttachment) => `${a.kind === "video" ? "Video" : "Image"} ${a.name}`;

/** A summary's attachments as a horizontal thumbnail row; tapping one opens the viewer there. */
export function AttachmentRow({ attachments }: { attachments: SummaryAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!attachments.length) return null;
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }} style={{ marginTop: 4 }}>
        {attachments.map((a, i) => (
          <Thumb key={a.id} attachment={a} onPress={() => setOpen(i)} />
        ))}
      </ScrollView>
      {open !== null && <AttachmentViewer attachments={attachments} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Thumb({ attachment: a, onPress }: { attachment: SummaryAttachment; onPress: () => void }) {
  const { client } = useStore();
  const c = useColors();
  const [failed, setFailed] = useState(false);
  const size = thumbSize(a);
  const uri = client.attachmentUrl(a.id);
  return (
    <Pressable
      onPress={() => {
        haptic("tap");
        onPress();
      }}
      accessibilityRole="imagebutton"
      accessibilityLabel={label(a)}
      accessibilityHint="Opens full screen"
      style={({ pressed }) => [s.thumb, size, { backgroundColor: c.bgActive, borderColor: c.border, opacity: pressed ? 0.75 : 1 }]}
    >
      {failed ? (
        <Failed name={a.name} compact />
      ) : a.kind === "image" ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <VideoPoster uri={uri} onError={() => setFailed(true)} />
      )}
      {a.kind === "video" && !failed && (
        <View style={s.playBadge} pointerEvents="none">
          <Icon name="play" size={14} color="#fff" strokeWidth={2} />
        </View>
      )}
    </Pressable>
  );
}

/** A video's first frame: a muted, paused player that never takes touches (the thumb's Pressable does). */
function VideoPoster({ uri, onError }: { uri: string; onError: () => void }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.muted = true;
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  useEffect(() => {
    if (status === "error") onError();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />
    </View>
  );
}

function Failed({ name, compact, dark }: { name: string; compact?: boolean; dark?: boolean }) {
  const c = useColors();
  const fg = dark ? "rgba(255,255,255,0.7)" : c.text3;
  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", gap: 6, padding: 8 }]}>
      <Icon name="alert" size={compact ? 18 : 28} color={fg} strokeWidth={1.75} />
      <Text style={{ color: fg, fontSize: compact ? 11.5 : 14, textAlign: "center" }} numberOfLines={compact ? 2 : 3}>
        {compact ? "Couldn't load" : `Couldn't load ${name}`}
      </Text>
    </View>
  );
}

/** How a page reports its pull-down to the viewer. */
interface Pull {
  onPull: (dy: number) => void;
  onRelease: (dismiss: boolean) => void;
}

/** Full-screen pager over one summary's attachments. */
export function AttachmentViewer({ attachments, start, onClose }: { attachments: SummaryAttachment[]; start: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(() => clampPage(start, attachments.length));
  const [zoomed, setZoomed] = useState(false);
  const pager = useRef<ScrollView>(null);
  // How far the page is pulled down (the page's own bounce moves it); it fades the chrome.
  const pulled = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  // Keep the current page in view across rotation (the page width changes).
  useEffect(() => {
    pager.current?.scrollTo({ x: index * width, animated: false });
  }, [width]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe down: every page is a vertical scroll view that bounces, so the pull is native (it
  // works over images, video and the failed placeholder alike, and never fights horizontal paging).
  const pull: Pull = {
    onPull: (dy) => {
      if (!closing.current) pulled.setValue(dy);
    },
    onRelease: (dismiss) => {
      if (!dismiss || closing.current) return;
      closing.current = true;
      haptic("tap");
      Animated.parallel([
        Animated.timing(slide, { toValue: height, duration: 200, useNativeDriver: true }),
        Animated.timing(pulled, { toValue: height, duration: 200, useNativeDriver: true }),
      ]).start(onClose);
    },
  };

  const backdrop = pulled.interpolate({ inputRange: [0, height * 0.5], outputRange: [1, 0.15], extrapolate: "clamp" });
  const chrome = pulled.interpolate({ inputRange: [0, 60], outputRange: [1, 0], extrapolate: "clamp" });
  const current = attachments[index];
  const headerHeight = insets.top + 56;
  const pageHeight = height - headerHeight - insets.bottom;

  return (
    <Modal visible transparent animationType="fade" presentationStyle="overFullScreen" statusBarTranslucent onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <StatusBar style="light" />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#000", opacity: backdrop }]} />
      <Animated.View style={[s.header, { height: headerHeight, paddingTop: insets.top, paddingLeft: insets.left + 8, paddingRight: insets.right + 8, opacity: chrome }]}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={({ pressed }) => [s.close, { opacity: pressed ? 0.6 : 1 }]}>
          <Icon name="x" size={18} color="#fff" strokeWidth={2.25} />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          {current && (
            <Text style={s.title} numberOfLines={1}>
              {current.name}
            </Text>
          )}
          {current && (
            <Text style={s.subtitle} numberOfLines={1}>
              {attachments.length > 1 ? `${index + 1} of ${attachments.length} · ` : ""}
              {formatSize(current.size)}
            </Text>
          )}
        </View>
        <View style={{ width: 36 }} />
      </Animated.View>
      <Animated.View style={{ flex: 1, transform: [{ translateY: slide }] }}>
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: index * width, y: 0 }}
          onMomentumScrollEnd={(e) => {
            const next = pageAt(e.nativeEvent.contentOffset.x, width, attachments.length);
            if (next !== index) {
              haptic("select");
              setIndex(next);
              setZoomed(false);
            }
          }}
          style={{ flex: 1 }}
        >
          {attachments.map((a, i) => (
            <View key={a.id} style={{ width, height }}>
              {a.kind === "image" ? (
                <ImagePage attachment={a} box={{ width, height: pageHeight }} inset={{ top: headerHeight, bottom: insets.bottom }} pull={pull} onZoom={i === index ? setZoomed : undefined} />
              ) : (
                <PageScroll box={{ width, height: pageHeight }} inset={{ top: headerHeight, bottom: insets.bottom }} pull={pull}>
                  <View style={{ width, height: pageHeight, alignItems: "center", justifyContent: "center" }}>
                    {i === index ? (
                      // Only the showing page holds a player, so paging away stops the video.
                      <VideoPage attachment={a} />
                    ) : (
                      <Icon name="play" size={34} color="rgba(255,255,255,0.6)" />
                    )}
                  </View>
                </PageScroll>
              )}
            </View>
          ))}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

/**
 * A full-height page that always bounces vertically: pulling it down reports the pull, and the
 * release says whether to close. With `zoom`, it's also the pinch-zoom surface.
 */
function PageScroll({
  box,
  inset,
  pull,
  zoom,
  scrollRef,
  children,
}: {
  box: { width: number; height: number };
  inset: { top: number; bottom: number };
  pull: Pull;
  zoom?: (zoomScale: number) => void;
  scrollRef?: RefObject<ScrollView | null>;
  children: ReactNode;
}) {
  const at = (e: NativeSyntheticEvent<NativeScrollEvent>) => ({ y: e.nativeEvent.contentOffset.y, scale: e.nativeEvent.zoomScale ?? 1 });
  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ width: box.width, height: inset.top + box.height + inset.bottom, paddingTop: inset.top, paddingBottom: inset.bottom, alignItems: "center", justifyContent: "center" }}
      alwaysBounceVertical
      maximumZoomScale={zoom ? 4 : 1}
      minimumZoomScale={1}
      bouncesZoom={!!zoom}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(e) => {
        const { y, scale } = at(e);
        zoom?.(scale);
        pull.onPull(pullOf(y, scale));
      }}
      onScrollEndDrag={(e) => {
        const { y, scale } = at(e);
        pull.onRelease(dismissOnRelease(y, e.nativeEvent.velocity?.y ?? 0, scale));
      }}
    >
      {children}
    </ScrollView>
  );
}

/** One image, fitted to the page; pinch (or double-tap) to zoom via the iOS scroll view's zoom. */
function ImagePage({ attachment: a, box, inset, pull, onZoom }: { attachment: SummaryAttachment; box: { width: number; height: number }; inset: { top: number; bottom: number }; pull: Pull; onZoom?: (zoomed: boolean) => void }) {
  const { client } = useStore();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const zoomer = useRef<ScrollView>(null);
  const lastTap = useRef(0);
  const zoomedIn = useRef(false);
  const fitted = fitSize(a, box);
  // Double-tap toggles between fitted and 2.5× on the middle, like Photos.
  const toggleZoom = () => {
    const f = zoomedIn.current ? 1 : 0.4;
    zoomer.current?.getScrollResponder().scrollResponderZoomTo({ x: (box.width * (1 - f)) / 2, y: inset.top + (box.height * (1 - f)) / 2, width: box.width * f, height: box.height * f, animated: true });
  };
  return (
    <PageScroll
      box={box}
      inset={inset}
      pull={pull}
      scrollRef={zoomer}
      zoom={
        failed
          ? undefined
          : (scale) => {
              const z = scale > 1.01;
              if (z !== zoomedIn.current) {
                zoomedIn.current = z;
                onZoom?.(z);
              }
            }
      }
    >
      {failed ? (
        <Failed name={a.name} dark />
      ) : (
        <Pressable
          accessibilityLabel={label(a)}
          onPress={() => {
            const now = Date.now();
            if (now - lastTap.current < 280) {
              toggleZoom();
              lastTap.current = 0;
            } else lastTap.current = now;
          }}
        >
          <Image source={{ uri: client.attachmentUrl(a.id) }} style={fitted} resizeMode="contain" onLoadEnd={() => setLoading(false)} onError={() => setFailed(true)} />
          {loading && <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(255,255,255,0.04)" }]} />}
        </Pressable>
      )}
    </PageScroll>
  );
}

/** A video with the system's controls; it plays while its page is showing. */
function VideoPage({ attachment: a }: { attachment: SummaryAttachment }) {
  const { client } = useStore();
  const player = useVideoPlayer({ uri: client.attachmentUrl(a.id) }, (p) => {
    p.play();
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  if (status === "error") return <Failed name={a.name} dark />;
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls fullscreenOptions={{ enable: true }} allowsPictureInPicture={false} />;
}

const s = StyleSheet.create({
  thumb: { borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  playBadge: { position: "absolute", left: "50%", top: "50%", width: 34, height: 34, marginLeft: -17, marginTop: -17, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", paddingLeft: 2 },
  header: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 2, flexDirection: "row", alignItems: "center", gap: 8 },
  close: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 15, fontWeight: "600" },
  subtitle: { color: "rgba(255,255,255,0.6)", fontSize: 12.5, marginTop: 1 },
});
