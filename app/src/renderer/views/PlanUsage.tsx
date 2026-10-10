// The sidebar foot's plan-usage gauges: one compact bar per driver window (Claude 5-hour / Weekly,
// Copilot Premium requests). The numbers, colours and wording come from state/planUsage.ts.
import { useEffect, useState } from "react";
import type { PlanUsageReport } from "@harness/shared";
import { MenuButton } from "../components/bits";
import { updateLayout, useLayout } from "../state/layout";
import { filterChoices, infoText, rowsFor, USAGE_MODES } from "../state/planUsage";
import { useStore } from "../state/store";

/** The latest report: fetched on every (re)connect, then pushed by usage.updated. */
function usePlanUsage(): PlanUsageReport | null {
  const { client, onEvent, epoch, state } = useStore();
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  useEffect(() => onEvent((e) => e.kind === "usage.updated" && setReport(e.usage)), [onEvent]);
  useEffect(() => {
    if (!state.connected) return;
    let live = true;
    client.getUsage().then(
      (r) => live && setReport(r),
      () => {}, // an older service has no /usage: no section
    );
    return () => void (live = false);
  }, [client, epoch, state.connected]);
  return report;
}

/** Re-render each minute so reset times and projected bars move between polls. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function PlanUsage() {
  const report = usePlanUsage();
  const { usageFilter, usageMode } = useLayout();
  const now = useClock();
  // Nothing reports plan usage (no plan, or an older service): no section at all.
  if (!report || report.drivers.length === 0) return null;

  const hidden = usageFilter === "hide";
  const groups = rowsFor(report, usageFilter, usageMode, now);
  // Several drivers show their name above their rows; one driver's rows speak for themselves.
  const named = groups.length > 1;

  return (
    <section className="plan-usage" data-testid="plan-usage" aria-label="Plan usage">
      <div className="plan-usage-head">
        <span className="section-title grow">Plan usage</span>
        <MenuButton
          align="right"
          className="plan-usage-menu"
          menuClassName="plan-usage-info"
          trigger={(toggle, open) => (
            <button className="plan-usage-btn" data-testid="plan-usage-info" aria-label="About plan usage" aria-expanded={open} onClick={toggle}>
              ⓘ
            </button>
          )}
        >
          {() => <p className="plan-usage-info-text">{infoText(usageMode)}</p>}
        </MenuButton>
        <MenuButton
          align="right"
          className="plan-usage-menu"
          trigger={(toggle, open) => (
            <button className="plan-usage-btn" data-testid="plan-usage-menu" aria-haspopup="menu" aria-expanded={open} aria-label="Plan usage options" onClick={toggle}>
              ⋯
            </button>
          )}
        >
          {(close) => (
            <>
              {filterChoices(report, usageFilter).map((c) => (
                <button key={c.id} role="menuitemradio" aria-checked={usageFilter === c.id} onClick={() => (close(), updateLayout({ usageFilter: c.id }))}>
                  <span className="plan-usage-check">{usageFilter === c.id ? "✓" : ""}</span> {c.label}
                </button>
              ))}
              <div className="menu-sep" role="separator" />
              {USAGE_MODES.map((m) => (
                <button key={m.id} role="menuitemradio" aria-checked={usageMode === m.id} onClick={() => (close(), updateLayout({ usageMode: m.id }))}>
                  <span className="plan-usage-check">{usageMode === m.id ? "✓" : ""}</span> {m.label}
                </button>
              ))}
            </>
          )}
        </MenuButton>
      </div>
      {!hidden && groups.length === 0 && <div className="plan-usage-note">Nothing to show</div>}
      {!hidden &&
        groups.map((g) => (
          <div key={g.driver} className="plan-usage-driver" data-driver={g.driver}>
            {(named || g.note) && <div className="plan-usage-name">{g.name}</div>}
            {g.note && (
              <div className="plan-usage-note" data-testid="plan-usage-note">
                {g.note}
              </div>
            )}
            {g.rows.map((r) => (
              <div key={r.id} className={`plan-usage-row tone-${r.tone}`} data-testid="plan-usage-row" data-window={r.id} title={r.title} aria-label={r.title}>
                <div className="plan-usage-line">
                  <span className="grow truncate plan-usage-label">{r.label}</span>
                  <span className="plan-usage-reset truncate">{r.reset}</span>
                </div>
                <div className="plan-usage-bar" role="img" aria-hidden>
                  <div className="plan-usage-fill" style={{ width: `${r.fill}%` }} />
                  {r.tick && <div className="plan-usage-tick" />}
                </div>
                <div className="plan-usage-text truncate">{r.text}</div>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
