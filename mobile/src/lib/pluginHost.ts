// WebView transport for the plugin host bridge (DESIGN.md "Plugins" → "Bridge"). The iOS app hosts
// plugin tab UIs in react-native-webview and drives them with the same `createPluginHostBridge` the
// desktop iframe uses; this file adapts the WebView's channels to the bridge's FrameWindow /
// HostMessageEvent shapes. Pure TS (no react-native imports) so bun can test it.
//
//   host → page: webview.injectJavaScript(buildInjection(msg, serviceOrigin)), which calls
//                window.postMessage inside the page only if the page is still at serviceOrigin
//   page → host: window.ReactNativeWebView.postMessage(JSON.stringify(msg)) → onMessage's
//                nativeEvent → webViewMessageEvent(nativeEvent, frame) → bridge.onMessage

import type { FrameWindow, HostMessageEvent } from "@harness/shared/state";

/** JSON that is also a safe JS expression (JSON allows U+2028/U+2029 raw; older JS parsers don't). */
function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * A script for `injectJavaScript` that delivers `msg` as a window "message" event inside the page,
 * but only when the page is still at `targetOrigin` (so the token never reaches a page that
 * navigated away). Ends in `true;` as react-native-webview requires.
 */
export function buildInjection(msg: unknown, targetOrigin: string): string {
  const origin = jsLiteral(targetOrigin);
  return `(function(){ if (location.origin !== ${origin}) return; window.postMessage(${jsLiteral(msg)}, ${origin}); })(); true;`;
}

/**
 * Adapt a WebView onMessage `nativeEvent` into what `bridge.onMessage` reads. `source` should be
 * the frame from `createWebViewFrame` (the bridge checks `e.source === frame()`). Returns null when
 * the data isn't JSON or the URL can't be parsed.
 */
export function webViewMessageEvent(nativeEvent: { data: string; url: string }, source: unknown): HostMessageEvent | null {
  let data: unknown;
  let origin: string;
  try {
    data = JSON.parse(nativeEvent.data);
    origin = new URL(nativeEvent.url).origin;
  } catch {
    return null;
  }
  return { data, origin, source };
}

/** A FrameWindow whose postMessage injects the message into the WebView. */
export function createWebViewFrame(inject: (script: string) => void): FrameWindow {
  return {
    postMessage(message: unknown, targetOrigin: string) {
      inject(buildInjection(message, targetOrigin));
    },
  };
}
