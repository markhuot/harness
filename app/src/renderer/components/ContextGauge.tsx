import { useState } from "react";
import type { Ticket } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { Icon } from "./Icon";
import { MenuButton, Modal } from "./bits";
import { gaugeInfo, gaugeMenu, gaugeView, limitError, MISS_INFO, parseLimit, formatTokens, type GaugeView } from "../state/contextGauge";

// The dial: a half circle, left (empty) to right (the limit), centre (20, 20), radius 16.
const CX = 20;
const CY = 20;
const R = 16;
const point = (f: number, r = R) => {
  const a = Math.PI * (1 - f);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)] as const;
};
const arc = (from: number, to: number) => {
  const [x0, y0] = point(from);
  const [x1, y1] = point(to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

/** The semicircular dial: grey track, a red zone at the end, the two-tone fill, the prefix tick and one needle. */
function Dial({ view, spinning }: { view: GaugeView; spinning: boolean }) {
  const [nx, ny] = point(view.fraction, 13);
  const prefix = view.prefixFraction;
  const [px0, py0] = prefix === null ? [0, 0] : point(prefix, R - 4);
  const [px1, py1] = prefix === null ? [0, 0] : point(prefix, R + 3);
  return (
    <span className="gauge-dial" data-over={view.over || undefined} data-empty={view.empty || undefined} data-estimated={view.estimated || undefined}>
      <svg width={30} height={19} viewBox="0 0 40 25" aria-hidden>
        <path className="gauge-track" d={arc(0, 1)} />
        <path className="gauge-zone" d={arc(0.88, 1)} />
        {view.cachedFraction > 0 && <path className="gauge-cached" d={arc(0, view.cachedFraction)} />}
        {view.freshFraction > 0 && <path className="gauge-fresh" d={arc(view.cachedFraction, view.cachedFraction + view.freshFraction)} />}
        {prefix !== null && <line className="gauge-prefix" data-testid="gauge-prefix" x1={px0} y1={py0} x2={px1} y2={py1} />}
        {!spinning && <line className="gauge-needle" x1={CX} y1={CY} x2={nx} y2={ny} />}
        <circle className="gauge-hub" cx={CX} cy={CY} r={2} />
      </svg>
      {spinning && <span className="spinner gauge-spinner" data-testid="gauge-spinner" />}
    </span>
  );
}

/** ⓘ: toggles an explanation under it (inside the menu, so clicking it doesn't close the menu). */
function Info({ text, testid }: { text: string; testid: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" role="button" className="gauge-info-btn" data-testid={testid} aria-expanded={open} aria-label="What is this?" onClick={() => setOpen(!open)}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>
      {open && (
        <p className="gauge-info" role="note" data-testid={`${testid}-text`}>
          {text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
        </p>
      )}
    </>
  );
}

function LimitModal({ current, onClose }: { current: number; onClose: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const [text, setText] = useState(String(current));
  const value = parseLimit(text);
  const error = limitError(value);
  const save = async () => {
    if (error) return;
    const ok = await act(() => client.updateSettings({ contextGaugeLimit: value }));
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} width={360}>
      <form
        data-testid="gauge-limit-modal"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-head">
          <strong>Context gauge limit</strong>
        </div>
        <div className="modal-body">
          <p className="dim" style={{ marginTop: 0 }}>
            Where the gauge turns red, in tokens (10k to 2M). Try 250k or 1.5M.
          </p>
          <input className="input" autoFocus data-testid="gauge-limit-input" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!error} aria-label="Limit in tokens" />
          {error && (
            <p className="gauge-limit-error" role="alert" data-testid="gauge-limit-error">
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" data-testid="gauge-limit-save" disabled={!!error}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewSessionModal({ view, onClose, onConfirm }: { view: GaugeView; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onClose} width={420}>
      <div data-testid="gauge-new-modal">
        <div className="modal-head">
          <strong>Start a new session?</strong>
        </div>
        <div className="modal-body">
          <p className="dim" style={{ margin: 0 }}>
            This discards the saved conversation{view.empty ? "" : ` (${formatTokens(view.total)} tokens)`}. The next run starts fresh from the spec, Activity and branch.
          </p>
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-danger" data-testid="gauge-new-confirm" autoFocus onClick={onConfirm}>
            New session
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The context fuel gauge in a ticket's header: how full the resumable conversation is, as a dial
 * that's also the button for Compact, New session and Limit… (state/contextGauge.ts has the rules).
 */
export function ContextGauge({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, navigate } = useStore();
  const act = useAction();
  const [modal, setModal] = useState<"new" | "limit" | null>(null);
  const driver = state.drivers.find((d) => d.id === ticket.driver);
  const menu = gaugeMenu(ticket, driver);
  if (!menu.visible) return null;
  const limit = state.settings?.contextGaugeLimit;
  const view = gaugeView(ticket.context, limit);
  const compacting = !!ticket.compacting;

  const run = async (action: "compact" | "new") => {
    // A 409 (a run started, or it's compacting) is the service's refusal: act() toasts it.
    const t = await act(() => client.sessionAction(ticket.key, action));
    if (t) dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: t } });
  };

  return (
    <>
      <MenuButton
        align="left"
        className="context-gauge-wrap"
        menuClassName="gauge-menu"
        trigger={(toggle, open) => (
          <button
            type="button"
            className="context-gauge"
            data-testid="context-gauge"
            data-over={view.over || undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={compacting ? "Context: compacting" : view.title}
            title={compacting ? "Compacting the session…" : view.title}
            disabled={menu.disabled}
            onClick={toggle}
          >
            <Dial view={view} spinning={compacting} />
            <span className="gauge-label" data-testid="gauge-label">
              {compacting ? "Compacting…" : view.label}
            </span>
            {view.missBadge && (
              <span className="gauge-miss" data-testid="gauge-miss-badge">
                {view.missBadge}
              </span>
            )}
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="gauge-menu-head">
              <span>{view.title}</span>
              <Info text={gaugeInfo(view.estimated)} testid="gauge-info" />
            </div>
            {view.missRow && (
              <div className="gauge-miss-row" data-testid="gauge-miss-row">
                <div className="gauge-miss-text">
                  <span>{view.missRow}</span>
                  <Info text={MISS_INFO} testid="gauge-miss-info" />
                </div>
                <button
                  type="button"
                  role="button"
                  className="gauge-link"
                  data-testid="gauge-miss-link"
                  onClick={() => (close(), navigate({ view: "settings", section: "drivers" }))}
                >
                  Claude Code driver settings
                </button>
              </div>
            )}
            <hr />
            {menu.compact.shown && (
              <button role="menuitem" data-testid="gauge-compact" disabled={!menu.compact.enabled} title={menu.compact.hint ?? undefined} onClick={() => (close(), void run("compact"))}>
                <Icon name="layers" /> Compact
                {menu.compact.hint && <span className="gauge-hint">{menu.compact.hint}</span>}
              </button>
            )}
            {menu.newSession.shown && (
              <button role="menuitem" data-testid="gauge-new" disabled={!menu.newSession.enabled} title={menu.newSession.hint ?? undefined} onClick={() => (close(), setModal("new"))}>
                <Icon name="refresh" /> New session
                {menu.newSession.hint && <span className="gauge-hint">{menu.newSession.hint}</span>}
              </button>
            )}
            <button role="menuitem" data-testid="gauge-limit" onClick={() => (close(), setModal("limit"))}>
              <Icon name="edit" /> Limit… <span className="gauge-hint">{formatTokens(view.limit)}</span>
            </button>
          </>
        )}
      </MenuButton>
      {modal === "new" && (
        <NewSessionModal
          view={view}
          onClose={() => setModal(null)}
          onConfirm={() => {
            setModal(null);
            void run("new");
          }}
        />
      )}
      {modal === "limit" && <LimitModal current={view.limit} onClose={() => setModal(null)} />}
    </>
  );
}
