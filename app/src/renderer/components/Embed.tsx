// Page attachments embedded in a spec (DESIGN.md "Embedded pages"): an HTML file or folder bundle an
// agent linked on its own line, shown as a sandboxed iframe at harness-embed://<id>/. Main answers
// that scheme from the service with the token (main/embeds.ts), so the page never sees it.
//
// The frame gets allow-scripts and allow-popups only: no allow-same-origin (its origin is opaque, so
// it can't reach the app's page, storage or cookies), no top navigation, no downloads, no modals.
// The service adds a sizing script to every page, which posts { harnessEmbedHeight } to the parent;
// a message counts only when it comes from this embed's own frame (every sandboxed frame's origin is
// "null", so the origin can't tell them apart), and embedSizeAfter decides the height.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { embedSizeAfter, initialEmbedSize } from "@harness/shared/state";
import { Modal } from "./bits";
import { Icon } from "./Icon";

export const EMBED_SANDBOX = "allow-scripts allow-popups";

/** The page's entry URL (main/embeds.ts serves the scheme). */
export const embedSrc = (id: string) => `harness-embed://${id.toLowerCase()}/`;

interface EmbedScope {
  /** Show the page full screen, over the window. */
  open: (id: string, text: string) => void;
}

const EmbedScopeContext = createContext<EmbedScope | null>(null);

/** Where embeds below open full screen: the overlay lives here, one at a time. */
export function EmbedScopeProvider({ children }: { children: ReactNode }) {
  const [full, setFull] = useState<{ id: string; text: string } | null>(null);
  const scope = useMemo<EmbedScope>(() => ({ open: (id, text) => setFull({ id, text }) }), []);
  const close = useCallback(() => setFull(null), []);
  return (
    <EmbedScopeContext.Provider value={scope}>
      {children}
      {full && <EmbedFullScreen id={full.id} text={full.text} onClose={close} />}
    </EmbedScopeContext.Provider>
  );
}

/**
 * The messages an embed's own frame posts (and only its own): its height, run through the sizing
 * rule, and a failed load (main's answer when the page can't be fetched).
 */
function useEmbedFrame() {
  const ref = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState(initialEmbedSize);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const own = ref.current?.contentWindow;
      if (!own || e.source !== own) return;
      const data: unknown = e.data;
      if (!data || typeof data !== "object") return;
      if ("harnessEmbedFailed" in data) setFailed(true);
      else if ("harnessEmbedHeight" in data) setSize((s) => embedSizeAfter(s, (data as { harnessEmbedHeight: unknown }).harnessEmbedHeight, performance.now()));
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, []);
  return { ref, size, failed, fail: () => setFailed(true) };
}

function FullScreenButton({ id, text }: { id: string; text: string }) {
  const scope = useContext(EmbedScopeContext);
  if (!scope) return null;
  return (
    <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Show ${text} full screen`} title="Full screen" data-testid="md-embed-full" onClick={() => scope.open(id, text)}>
      <Icon name="expand" />
    </button>
  );
}

/** A page attachment on its own line: a caption bar with a full-screen button over the live page. */
export function PageEmbed({ id, text }: { id: string; text: string }) {
  const { ref, size, failed, fail } = useEmbedFrame();
  return (
    <figure className={`md-embed ${failed ? "is-failed" : ""}`} data-testid="md-embed" data-embed-id={id}>
      <figcaption className="md-embed-bar">
        <Icon name="globe" size={12} />
        <span className="md-embed-title" title={text}>
          {text}
        </span>
        <FullScreenButton id={id} text={text} />
      </figcaption>
      {failed ? (
        <div className="md-embed-failed" data-testid="md-embed-failed">
          <Icon name="alert" size={16} />
          <span>This page couldn't be loaded.</span>
        </div>
      ) : (
        <iframe
          ref={ref}
          className="md-embed-frame"
          data-testid="md-embed-frame"
          src={embedSrc(id)}
          sandbox={EMBED_SANDBOX}
          referrerPolicy="no-referrer"
          title={text}
          style={{ height: size.height }}
          onError={fail}
        />
      )}
    </figure>
  );
}

/** A page attachment inside a line: a link that opens the page full screen (text when there's nowhere to open it). */
export function PageLink({ id, text }: { id: string; text: string }) {
  const scope = useContext(EmbedScopeContext);
  if (!scope) return <>{text}</>;
  return (
    <a
      href={embedSrc(id)}
      className="md-embed-link"
      data-testid="md-embed-link"
      onClick={(e) => {
        e.preventDefault();
        scope.open(id, text);
      }}
    >
      {text}
    </a>
  );
}

/**
 * The page over the whole window, live, with a close button. Escape closes it: Modal takes the key
 * when the app's page has it, and main passes it on (onEmbedEscape) when the page's frame has focus,
 * since a key pressed in the frame never reaches the app's page.
 */
function EmbedFullScreen({ id, text, onClose }: { id: string; text: string; onClose: () => void }) {
  const { ref, failed, fail } = useEmbedFrame();
  useEffect(() => window.harness?.onEmbedEscape?.(() => document.activeElement === ref.current && onClose()), [ref, onClose]);
  return (
    <Modal onClose={onClose} className="embed-full">
      <div className="embed-full-bar">
        <Icon name="globe" size={13} />
        <span className="embed-full-title" title={text}>
          {text}
        </span>
        <div className="grow" />
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close" title="Close (Esc)" data-testid="embed-full-close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {failed ? (
        <div className="md-embed-failed" data-testid="md-embed-failed">
          <Icon name="alert" size={16} />
          <span>This page couldn't be loaded.</span>
        </div>
      ) : (
        <iframe ref={ref} className="embed-full-frame" data-testid="embed-full-frame" src={embedSrc(id)} sandbox={EMBED_SANDBOX} referrerPolicy="no-referrer" title={text} onError={fail} />
      )}
    </Modal>
  );
}
