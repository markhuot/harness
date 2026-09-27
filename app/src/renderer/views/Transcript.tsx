import { memo, useEffect, useMemo, useState } from "react";
import type { ToolResultContent, TranscriptEntry } from "@harness/shared";
import { useStore } from "../state/store";
import { formatMaybeJson, groupTranscript, liveDelta, shortToolName, toolIcon, toolPreview } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { PermissionStatusRow } from "../components/PermissionLog";
import { useStickToBottom } from "../components/stickToBottom";

export { groupTranscript, toolPreview } from "@harness/shared/state";

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
  const scroller = useStickToBottom<HTMLDivElement>();

  const loading = !transcript?.loaded && !error;

  return (
    <div className="transcript" ref={scroller}>
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
      if (c.permission) return <PermissionStatusRow log={c.permission} time={time} />;
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

const ToolRow = memo(function ToolRow({
  call,
  result,
}: {
  call: (TranscriptEntry & { content: { type: "tool_call" } }) | null;
  result?: TranscriptEntry & { content: { type: "tool_result" } };
}) {
  const [open, setOpen] = useState(false);
  const name = shortToolName(call?.content.name ?? result?.content.name ?? "tool");
  const preview = call ? toolPreview(name, call.content.input) : "";
  const isError = result?.content.isError;
  return (
    <div className={`t-tool ${open ? "open" : ""} ${isError ? "error" : ""}`}>
      <button className="t-tool-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name={toolIcon(name)} size={12} />
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
