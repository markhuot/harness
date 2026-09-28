// A textarea that autocompletes @-mentions of project files (shared/src/mentions.ts): typing `@fo`
// lists matching files and folders; ↑/↓ move, Enter or Tab picks, Escape closes. Picking a folder
// keeps the list open inside it. The service attaches the mentioned files to the agent's prompt.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { activeMention, insertMention, type FileMatch } from "@harness/shared";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Files matching the query; rejected or stale lookups show nothing. */
  search: (query: string) => Promise<FileMatch[]>;
  /** Where the list opens when there's room: under the field (new session) or over it (the composer at a pane's foot). */
  placement?: "above" | "below";
};

const DEBOUNCE_MS = 60;

export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea({ value, onValueChange, search, placement = "below", onKeyDown, className, ...rest }, forwarded) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwarded, () => ref.current!, []);
  const [caret, setCaret] = useState<number | null>(null);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [index, setIndex] = useState(0);
  // Escape hides the list until the caret leaves that mention.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);

  const mention = caret === null ? null : activeMention(value, caret);
  const open = !!mention && dismissed !== mention.start && matches.length > 0;
  const query = mention?.query ?? null;

  useEffect(() => {
    if (dismissed !== null && mention?.start !== dismissed) setDismissed(null);
  }, [mention?.start, dismissed]);

  useEffect(() => {
    if (query === null) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      search(query).then(
        (m) => live && (setMatches(m), setIndex(0)),
        () => live && setMatches([]),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, search]);

  // Put the caret after an inserted mention once React has rendered the new value.
  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  }, [value]);

  // The list is portaled with fixed positioning so the modal's or pane's overflow can't clip it.
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const measure = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      menu.style.width = `${anchor.width}px`;
      const cap = menu.style.maxHeight;
      menu.style.maxHeight = "";
      const { width, height } = menu.getBoundingClientRect();
      menu.style.maxHeight = cap;
      setPlace(placeMenu({ anchor, width, height, vw: innerWidth, vh: innerHeight, align: "left", prefer: placement }));
    };
    measure();
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [open, matches, placement]);

  const track = () => {
    const el = ref.current;
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const pick = (m: FileMatch) => {
    if (!mention) return;
    const next = insertMention(value, mention, m.path);
    pendingCaret.current = next.caret;
    onValueChange(next.text);
    ref.current?.focus();
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(matches[Math.min(index, matches.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        // Close the list, not the modal or pane behind it.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(mention!.start);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <>
      <textarea
        {...rest}
        ref={ref}
        className={className}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart === e.target.selectionEnd ? e.target.selectionStart : null);
        }}
        onSelect={track}
        onKeyDown={keyDown}
        onBlur={(e) => {
          rest.onBlur?.(e);
          setCaret(null);
        }}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            className="mention-menu"
            role="listbox"
            aria-label="Files"
            style={{ left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: place?.maxHeight ?? undefined, visibility: place ? undefined : "hidden" }}
          >
            {matches.map((m, i) => (
              <MentionRow key={m.path} match={m} active={i === index} onPick={() => pick(m)} onHover={() => setIndex(i)} />
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
});

function MentionRow({ match, active, onPick, onHover }: { match: FileMatch; active: boolean; onPick: () => void; onHover: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const trimmed = match.path.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  const name = trimmed.slice(slash + 1) + (match.kind === "dir" ? "/" : "");
  const dir = slash === -1 ? "" : trimmed.slice(0, slash + 1);
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={active}
      className={active ? "on" : ""}
      // mousedown, not click: the textarea keeps focus (and its caret) through the pick.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseMove={onHover}
    >
      <Icon name={match.kind === "dir" ? "folder" : "fileText"} size={13} />
      <span className="mention-name">{name}</span>
      {dir && <span className="mention-dir">{dir}</span>}
    </li>
  );
}
