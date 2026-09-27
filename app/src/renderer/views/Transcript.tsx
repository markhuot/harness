import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ToolResultContent, TranscriptEntry } from "@harness/shared";
import { useStore } from "../state/store";
import { liveDelta } from "../state/reducer";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";

type Item =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "tool"; call: TranscriptEntry & { content: { type: "tool_call" } }; result?: TranscriptEntry & { content: { type: "tool_result" } } };

/** Pair each tool_call with its tool_result (by callId) so they render as one collapsible row. */
export function groupTranscript(entries: TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const e of entries) {
    if (e.content.type === "tool_call") {
      const item = { kind: "tool" as const, call: e as Extract<Item, { kind: "tool" }>["call"] };
      calls.set(e.content.callId, item);
      items.push(item);
    } else if (e.content.type === "tool_result" && calls.has(e.content.callId)) {
      calls.get(e.content.callId)!.result = e as Extract<Item, { kind: "tool" }>["result"];
    } else {
      items.push({ kind: "entry", entry: e });
    }
  }
  return items;
}

export function Transcript({ sessionId, emptyHint }: { sessionId: string; emptyHint?: string }) {
  const { state, client, dispatch, epoch } = useStore();
  const [error, setError] = useState<string | null>(null);
  const transcript = state.transcripts[sessionId];
  const deltas = liveDelta(state, sessionId);
  const session = state.sessions[sessionId];

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .transcript(sessionId, 0)
      .then((entries) => !cancelled && dispatch({ type: "transcript", sessionId, entries }))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, sessionId, epoch]);

  const items = useMemo(() => groupTranscript(transcript?.entries ?? []), [transcript?.entries]);

  // Stick to the bottom while the user is there; leave them alone when they scroll up.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const deltaText = deltas.map((d) => d.text).join("");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, deltaText]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const loading = !transcript?.loaded && !error;

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="transcript-inner">
        {error && (
          <div className="t-error">
            <Icon name="alert" /> Couldn't load the transcript: {error}
          </div>
        )}
        {loading && items.length === 0 && (
          <div className="empty">
            <div className="spinner" />
          </div>
        )}
        {!loading && items.length === 0 && deltas.length === 0 && (
          <div className="empty">
            <Icon name="message" />
            <strong>No messages yet</strong>
            {emptyHint}
          </div>
        )}
        {items.map((item) =>
          item.kind === "tool" ? <ToolRow key={item.call.id} call={item.call} result={item.result} /> : <EntryRow key={item.entry.id} entry={item.entry} />,
        )}
        {deltas.map((d) => (
          <div key={d.runId} className="t-assistant streaming">
            <div className="t-who">
              <Icon name="sparkle" size={12} /> Agent
            </div>
            <div className="md selectable">
              <p>
                {d.text}
                <span className="caret" />
              </p>
            </div>
          </div>
        ))}
        {session?.busy && deltas.length === 0 && (
          <div className="t-working">
            <span className="spinner" /> Working…
          </div>
        )}
      </div>
    </div>
  );
}

const EntryRow = memo(function EntryRow({ entry }: { entry: TranscriptEntry }) {
  const c = entry.content;
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  switch (c.type) {
    case "text":
      if (entry.role === "user") {
        return (
          <div className="t-user">
            <div className="t-who">
              <Icon name="user" size={12} /> You <span className="t-time">{time}</span>
            </div>
            <div className="t-bubble">
              <Markdown text={c.text} />
            </div>
          </div>
        );
      }
      if (entry.role === "system") {
        return (
          <div className="t-system">
            <Markdown text={c.text} />
          </div>
        );
      }
      return (
        <div className="t-assistant">
          <div className="t-who">
            <Icon name="sparkle" size={12} /> Agent <span className="t-time">{time}</span>
          </div>
          <Markdown text={c.text} />
        </div>
      );
    case "thinking":
      return <Thinking text={c.text} />;
    case "status":
      return (
        <div className="t-status">
          <span className="t-rule" />
          <span className="t-status-text">
            {c.text}
            <span className="t-time">{time}</span>
          </span>
          <span className="t-rule" />
        </div>
      );
    case "error":
      return (
        <div className="t-error selectable">
          <Icon name="alert" />
          <span>{c.text}</span>
        </div>
      );
    case "tool_result":
      // Orphan result (its call wasn't in view): show compactly.
      return <ToolRow call={null} result={entry as never} />;
    case "tool_call":
      return null;
  }
});

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`t-thinking ${open ? "open" : ""}`}>
      <button onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> Thinking
      </button>
      {open ? <div className="t-thinking-body selectable">{text}</div> : <span className="truncate t-thinking-peek">{text}</span>}
    </div>
  );
}

/** One-line preview of a tool input, e.g. the bash command or file path. */
export function toolPreview(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "url", "path", "file_path", "selector", "pattern", "key", "title", "question", "summary", "expression", "text"]) {
      if (typeof o[k] === "string" && o[k]) return String(o[k]).split("\n")[0]!;
    }
    const s = JSON.stringify(o);
    return s === "{}" ? "" : s;
  }
  return input === undefined || input === null ? "" : String(input);
}

function prettyName(name: string) {
  // mcp__harness__post_summary → post_summary
  return name.replace(/^mcp__[^_]+__/, "");
}

const ToolRow = memo(function ToolRow({
  call,
  result,
}: {
  call: (TranscriptEntry & { content: { type: "tool_call" } }) | null;
  result?: TranscriptEntry & { content: { type: "tool_result" } };
}) {
  const [open, setOpen] = useState(false);
  const name = prettyName(call?.content.name ?? result?.content.name ?? "tool");
  const preview = call ? toolPreview(name, call.content.input) : "";
  const isError = result?.content.isError;
  return (
    <div className={`t-tool ${open ? "open" : ""} ${isError ? "error" : ""}`}>
      <button className="t-tool-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name={name === "bash" || name === "Bash" ? "terminal" : name.startsWith("browser") ? "globe" : "tool"} size={12} />
        <span className="t-tool-name">{name}</span>
        <span className="t-tool-preview truncate">{preview}</span>
        {!result ? <span className="spinner" /> : isError ? <Icon name="x" size={12} className="t-bad" /> : <Icon name="check" size={12} className="t-ok" />}
      </button>
      {open && (
        <div className="t-tool-body selectable">
          {call && (
            <>
              <div className="t-label">Input</div>
              <pre>{JSON.stringify(call.content.input, null, 2)}</pre>
            </>
          )}
          {result && (
            <>
              <div className="t-label">{isError ? "Error" : "Output"}</div>
              <ToolOutput output={result.content.output} />
            </>
          )}
          {!result && <div className="muted">Running…</div>}
        </div>
      )}
    </div>
  );
});

function ToolOutput({ output }: { output: ToolResultContent[] }) {
  if (!output.length) return <div className="muted">(no output)</div>;
  return (
    <>
      {output.map((o, i) =>
        o.type === "text" ? (
          <pre key={i}>{formatMaybeJson(o.text)}</pre>
        ) : (
          <img key={i} className="t-image" src={`data:${o.mimeType};base64,${o.data}`} alt="Tool output" />
        ),
      )}
    </>
  );
}

function formatMaybeJson(text: string) {
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {}
  }
  return text.length > 20000 ? text.slice(0, 20000) + `\n… (${text.length - 20000} more characters)` : text;
}
