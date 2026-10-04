import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MessageAnnotation, PromptAttachment, Subagent, ToolResultContent, TranscriptEntry } from "@harness/shared";
import { useStore } from "../state/store";
import { annotationNotesLabel, formatMaybeJson, groupTranscript, isTask, liveDelta, shortToolName, SUBAGENT_STATUS_LABEL, subagentById, subagentOpenLabel, subagentsOf, subagentTitle, toolIcon, toolPreview, transcriptKey } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { PermissionStatusRow } from "../components/PermissionLog";
import { PromptAttachmentList } from "../components/PromptAttachments";
import { useStickToBottom } from "../components/stickToBottom";

export { groupTranscript, toolPreview } from "@harness/shared/state";

/**
 * A session's conversation, or with `subagentId` one of its sub-agents'. `onOpenSubagent` turns
 * the tool rows that started sub-agents or background tasks into links to their transcripts or output.
 */
export function Transcript({
  sessionId,
  subagentId = null,
  emptyHint,
  header,
  onOpenSubagent,
}: {
  sessionId: string;
  subagentId?: string | null;
  emptyHint?: string;
  /** Rendered above the first entry, scrolling with the transcript */
  header?: ReactNode;
  onOpenSubagent?: (subagentId: string) => void;
}) {
  const { state, client, dispatch, epoch } = useStore();
  const [error, setError] = useState<string | null>(null);
  const transcript = state.transcripts[transcriptKey(sessionId, subagentId)];
  // Sub-agents don't stream; their blocks arrive whole.
  const deltas = subagentId ? [] : liveDelta(state, sessionId);
  const session = state.sessions[sessionId];
  const subagent = subagentId ? subagentById(state, sessionId, subagentId) : null;
  const working = subagentId ? subagent?.status === "running" : session?.busy;
  const subagents = subagentsOf(state, sessionId);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .transcript(sessionId, 0, subagentId)
      .then((entries) => !cancelled && dispatch({ type: "transcript", sessionId, subagentId, entries }))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, sessionId, subagentId, epoch]);

  const items = useMemo(() => groupTranscript(transcript?.entries ?? []), [transcript?.entries]);

  // Stick to the bottom while the user is there; leave them alone when they scroll up.
  const scroller = useStickToBottom<HTMLDivElement>();

  const loading = !transcript?.loaded && !error;

  return (
    <div className="transcript" ref={scroller}>
      <div className="transcript-inner">
        {header}
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
          item.kind === "tool" ? (
            <ToolRow
              key={item.call.id}
              call={item.call}
              result={item.result}
              agent={onOpenSubagent ? (subagents?.find((a) => a.id === item.call.content.callId) ?? null) : null}
              onOpenAgent={onOpenSubagent}
            />
          ) : (
            <EntryRow key={item.entry.id} entry={item.entry} who={subagentId ? "Sub-agent" : "Agent"} />
          ),
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
        {working && deltas.length === 0 && (
          <div className="t-working">
            <span className="spinner" /> Working…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The files sent with a message, under its bubble: read-only, served from the transcript entry.
 * Their images can be annotated again; an annotated one lists its numbered notes behind "N notes".
 */
function MessageAttachments({ entryId, items, annotations }: { entryId: string; items: PromptAttachment[]; annotations?: MessageAnnotation[] }) {
  const { client } = useStore();
  const notes = (annotations ?? []).filter((a) => a.marks.length > 0 && items[a.attachment]);
  return (
    <div className="t-attachments" data-testid="message-attachments">
      <PromptAttachmentList
        items={items}
        ticketKey={null}
        urlOf={(i) => client.messageAttachmentUrl(entryId, i)}
        annotate={(index, a) => ({ kind: "message-attachment", entryId, index, name: a.name })}
      />
      {notes.map((a) => (
        <AnnotationNotes key={a.attachment} annotation={a} name={items.length > 1 ? items[a.attachment]!.name : null} />
      ))}
    </div>
  );
}

/** "N notes" under an annotated image; opens to the numbered list that went to the agent. */
function AnnotationNotes({ annotation, name }: { annotation: MessageAnnotation; name: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="t-annotations" data-testid="annotation-notes" data-attachment={annotation.attachment}>
      <button type="button" className="t-annotations-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {annotationNotesLabel(annotation.marks.length)}
        {name && <span className="muted truncate">on {name}</span>}
      </button>
      {open && (
        <ol className="t-annotations-list selectable" data-testid="annotation-notes-list">
          {annotation.marks.map((m) => (
            <li key={m.n}>
              <span className="t-annotations-n">{m.n}</span>
              {m.message ? <span>{m.message}</span> : <span className="empty-message">No message</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const EntryRow = memo(function EntryRow({ entry, who }: { entry: TranscriptEntry; who: string }) {
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
            {c.text.trim() && (
              <div className="t-bubble">
                <Markdown text={c.text} />
              </div>
            )}
            {!!c.attachments?.length && <MessageAttachments entryId={entry.id} items={c.attachments} annotations={c.annotations} />}
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
            <Icon name="sparkle" size={12} /> {who} <span className="t-time">{time}</span>
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
  agent = null,
  onOpenAgent,
}: {
  call: (TranscriptEntry & { content: { type: "tool_call" } }) | null;
  result?: TranscriptEntry & { content: { type: "tool_result" } };
  /** The sub-agent or background task this call started, when it started one */
  agent?: Subagent | null;
  onOpenAgent?: (id: string) => void;
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
      {agent && onOpenAgent && (
        <div className="t-tool-agent" data-agent={agent.id}>
          <Icon name={isTask(agent) ? "terminal" : "bot"} size={12} />
          <span className="truncate">
            {subagentTitle(agent)} · {SUBAGENT_STATUS_LABEL[agent.status]}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => onOpenAgent(agent.id)}>
            {subagentOpenLabel(agent)} <Icon name="chevronRight" size={11} />
          </button>
        </div>
      )}
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
