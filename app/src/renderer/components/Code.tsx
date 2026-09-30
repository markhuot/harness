// Syntax-highlighted code for chat messages (and anything else that shows a snippet). Colors come
// from @pierre/diffs' Shiki highlighter in the app theme's syntax theme (state/syntax.ts), the same
// as the Git tab. The plain text renders at once; tokens swap in when the block nears the viewport
// and the highlighter has an idle moment, and re-renders reuse the cached tokens.
//
// Diffs (```diff / ```patch, or an untagged block shaped like one) go through @pierre/diffs'
// FileDiff (CodeDiff.tsx, loaded on first use), so they look like the Git tab's diff viewer.
// Tokens become React spans (no innerHTML), so agent output can't inject markup.

import { memo, Suspense, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { codeKind, codeLanguage } from "@harness/shared/state";
import { useHighlight, useSyntaxTheme, type Lines } from "../state/syntax";
import { Icon } from "./Icon";
import { ChunkBoundary, retryableLazy } from "./lazyRetry";

export { useSyntaxTheme, type SyntaxTheme } from "../state/syntax";

const codeDiff = retryableLazy(() => import("./CodeDiff").then((m) => m.default));
const CodeDiff = codeDiff.Component;

/** True once `ref` comes within a screen or so of the viewport (and stays true). */
export function useNearViewport(ref: RefObject<Element | null>, margin = "600px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver !== "function") return void setNear(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return near;
}

const FONT_STYLE = (style = 0): CSSProperties | undefined =>
  style ? { fontStyle: style & 1 ? "italic" : undefined, fontWeight: style & 2 ? 600 : undefined, textDecoration: style & 4 ? "underline" : undefined } : undefined;

function Tokens({ lines }: { lines: Lines }) {
  return lines.map((line, i) => (
    <span key={i} className="code-line">
      {line.map((t, j) => (
        <span key={j} style={t.color || t.style ? { color: t.color, ...FONT_STYLE(t.style) } : undefined}>
          {t.text}
        </span>
      ))}
      {i < lines.length - 1 && "\n"}
    </span>
  ));
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="code-copy"
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

/** Plain code, highlighted as `lang` (a fence name like `ts` or a Shiki language; unknown → text). */
export const CodeBlock = memo(function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const { name } = useSyntaxTheme();
  const shiki = codeLanguage(lang);
  const lines = useHighlight(text, shiki, name, near && shiki !== "text");
  return (
    <div ref={ref} className="code-block" data-lang={shiki}>
      <pre>
        <code>{lines ? <Tokens lines={lines} /> : text}</code>
      </pre>
      <CopyButton text={text} />
    </div>
  );
});

/** A fenced block from markdown: a diff when it is one, else highlighted code. */
export const FencedCode = memo(function FencedCode({ text, lang }: { text: string; lang: string }) {
  if (codeKind(lang, text) === "code") return <CodeBlock text={text} lang={lang} />;
  const plain = <CodeBlock text={text} lang="diff" />;
  // A diff renderer that fails to load leaves the plain block; the next block to mount tries again.
  return (
    <ChunkBoundary lazies={[codeDiff]} fallback={() => plain}>
      <Suspense fallback={plain}>
        <CodeDiff text={text} fallback={plain} />
      </Suspense>
    </ChunkBoundary>
  );
});
