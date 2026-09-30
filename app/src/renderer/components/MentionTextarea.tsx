// A textarea that autocompletes @-mentions of project files (shared/src/mentions.ts) and, with
// `searchCommands`, a /command or skill that starts the text (shared/src/commands.ts): typing `@fo`
// lists matching files and folders, typing `/co` lists the agent's matching commands; ↑/↓ move,
// Enter or Tab picks, Escape closes. Picking a folder keeps the list open inside it. The service
// attaches the mentioned files to the agent's prompt; the agent expands the command itself.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { activeCommand, activeMention, insertCommand, insertMention, type CommandMatch, type FileMatch } from "@harness/shared";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { caretAnchor, caretOffset } from "./caretRect";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Files matching the query; rejected or stale lookups show nothing. */
  search: (query: string) => Promise<FileMatch[]>;
  /** The agent's slash commands and skills matching the query; without it a leading / is plain text. */
  searchCommands?: (query: string) => Promise<CommandMatch[]>;
  /** Where the list opens when there's room: under the field (new session) or over it (the composer at a pane's foot). */
  placement?: "above" | "below";
};

/** One row of the list: a file or folder for an @-mention, or a command for a leading /. */
type Item = { kind: "file"; match: FileMatch } | { kind: "command"; match: CommandMatch };

const DEBOUNCE_MS = 60;

export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea(
  { value, onValueChange, search, searchCommands, placement = "below", onKeyDown, className, ...rest },
  forwarded,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwarded, () => ref.current!, []);
  const [caret, setCaret] = useState<number | null>(null);
  const [found, setItems] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  // Escape hides the list until the caret leaves that mention or command.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);

  // A command only starts the text, so while one is being typed it wins over an @ inside it.
  const command = caret === null || !searchCommands ? null : activeCommand(value, caret);
  const mention = caret === null || command ? null : activeMention(value, caret);
  const active = command ?? mention;
  // Until the new lookup answers, the last one's results stay up while the query narrows, but
  // files never stand in for commands (or the other way round) after switching between @ and /.
  const items = found[0]?.kind === (command ? "command" : "file") ? found : [];
  const open = !!active && dismissed !== active.start && items.length > 0;
  // "/" and "@" keep the two lookups apart when the query text is the same.
  const lookup = command ? `/${command.query}` : mention ? `@${mention.query}` : null;

  useEffect(() => {
    if (dismissed !== null && active?.start !== dismissed) setDismissed(null);
  }, [active?.start, dismissed]);

  useEffect(() => {
    if (lookup === null) {
      setItems([]);
      return;
    }
    let live = true;
    const q = lookup.slice(1);
    const timer = setTimeout(() => {
      const found: Promise<Item[]> =
        lookup[0] === "/" && searchCommands
          ? searchCommands(q).then((m) => m.map((match) => ({ kind: "command", match })))
          : search(q).then((m) => m.map((match) => ({ kind: "file", match })));
      found.then(
        (m) => live && (setItems(m), setIndex(0)),
        () => live && setItems([]),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lookup, search, searchCommands]);

  // Put the caret after an inserted mention once React has rendered the new value.
  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  }, [value]);

  // The list is portaled with fixed positioning so the modal's or pane's overflow can't clip it.
  // It opens under the caret's line (over it with placement "above"), not the whole field, and
  // follows the caret as the text wraps or the field scrolls.
  useLayoutEffect(() => {
    if (!open || caret === null) return setPlace(null);
    const measure = () => {
      const el = ref.current;
      const menu = menuRef.current;
      if (!el || !menu) return;
      const field = el.getBoundingClientRect();
      const anchor = caretAnchor(field, caretOffset(el, caret), el.scrollTop);
      menu.style.width = `${field.width}px`;
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
  }, [open, items, placement, caret, value]);

  const track = () => {
    const el = ref.current;
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const pick = (item: Item) => {
    let next;
    if (item.kind === "command" && command) next = insertCommand(value, command, item.match.name);
    else if (item.kind === "file" && mention) next = insertMention(value, mention, item.match.path);
    else return;
    pendingCaret.current = next.caret;
    onValueChange(next.text);
    ref.current?.focus();
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + items.length) % items.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(items[Math.min(index, items.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        // Close the list, not the modal or pane behind it.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(active!.start);
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
            aria-label={items[0]?.kind === "command" ? "Commands" : "Files"}
            style={{ left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: place?.maxHeight ?? undefined, visibility: place ? undefined : "hidden" }}
          >
            {items.map((item, i) => (
              <MentionRow
                key={item.kind === "file" ? `@${item.match.path}` : `/${item.match.name}`}
                item={item}
                active={i === index}
                onPick={() => pick(item)}
                onHover={() => setIndex(i)}
              />
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
});

function MentionRow({ item, active, onPick, onHover }: { item: Item; active: boolean; onPick: () => void; onHover: () => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={active}
      className={active ? "on" : ""}
      title={item.kind === "command" ? item.match.description || undefined : undefined}
      // mousedown, not click: the textarea keeps focus (and its caret) through the pick.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseMove={onHover}
    >
      {item.kind === "command" ? <CommandLabel match={item.match} /> : <FileLabel match={item.match} />}
    </li>
  );
}

function FileLabel({ match }: { match: FileMatch }) {
  const trimmed = match.path.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  const name = trimmed.slice(slash + 1) + (match.kind === "dir" ? "/" : "");
  const dir = slash === -1 ? "" : trimmed.slice(0, slash + 1);
  return (
    <>
      <Icon name={match.kind === "dir" ? "folder" : "fileText"} size={13} />
      <span className="mention-name">{name}</span>
      {dir && <span className="mention-dir">{dir}</span>}
    </>
  );
}

function CommandLabel({ match }: { match: CommandMatch }) {
  return (
    <>
      <Icon name="zap" size={13} />
      <span className="mention-name">/{match.name}</span>
      {match.argumentHint && <span className="mention-hint">{match.argumentHint}</span>}
      {match.description && <span className="mention-dir">{match.description}</span>}
    </>
  );
}
