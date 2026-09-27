// Settings → Appearance: System / Light / Dark, plus the light and dark color theme picks.
// App-side: persisted by the main process (preferences.json), not the service.

import type { CSSProperties } from "react";
import { findTheme, themeCssVars, themesFor, type Theme, type ThemeAppearance } from "@harness/shared/themes";
import { THEME_PREFERENCES, type ThemePreference } from "../../../main/theme";
import { setThemePreference, updateTheme, useTheme } from "../../state/theme";
import { Row, Section } from "../Settings";
import "./appearance.css";

const THEME_LABEL: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };

/** A theme's tokens as --p-* custom properties, so a preview draws in that theme, not the current one. */
function previewVars(t: Theme): CSSProperties {
  return Object.fromEntries(themeCssVars(t.tokens, "--p-")) as CSSProperties;
}

export function AppearanceSection() {
  const theme = useTheme();
  const light = findTheme(theme.lightTheme)!;
  const dark = findTheme(theme.darkTheme)!;
  return (
    <Section id="appearance" title="Appearance">
      <div className="card-surface settings-card">
        <Row
          title="Appearance"
          sub={
            theme.forced
              ? `Forced to ${findTheme(theme.themeId)?.name ?? theme.forced} by HARNESS_THEME / HARNESS_THEME_ID.`
              : theme.preference === "system"
                ? `Follows macOS (currently ${theme.resolved}).`
                : "Stays the same regardless of the macOS setting."
          }
        >
          <div className="theme-picker" role="radiogroup" aria-label="Appearance">
            {THEME_PREFERENCES.map((pref) => (
              <button
                key={pref}
                role="radio"
                aria-checked={theme.preference === pref}
                data-theme-option={pref}
                className={`theme-option ${theme.preference === pref ? "on" : ""}`}
                onClick={() => void setThemePreference(pref)}
              >
                <span className="theme-swatch">
                  {pref !== "dark" && <span className="sw" style={previewVars(light)} />}
                  {pref !== "light" && <span className="sw" style={previewVars(dark)} />}
                </span>
                {THEME_LABEL[pref]}
              </button>
            ))}
          </div>
        </Row>
        <ThemeGrid appearance="light" selected={theme.lightTheme} active={theme.themeId} />
        <ThemeGrid appearance="dark" selected={theme.darkTheme} active={theme.themeId} />
      </div>
    </Section>
  );
}

function ThemeGrid({ appearance, selected, active }: { appearance: ThemeAppearance; selected: string; active: string }) {
  const title = appearance === "light" ? "Light theme" : "Dark theme";
  return (
    <div className="settings-form theme-grid-block">
      <div className="settings-row-main">
        <div className="settings-row-title">{title}</div>
        <div className="settings-row-sub">Used when the appearance is {appearance}.</div>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label={title} data-theme-grid={appearance}>
        {themesFor(appearance).map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={t.id === selected}
            data-theme-pick={`${appearance}:${t.id}`}
            className={`theme-card ${t.id === selected ? "on" : ""}`}
            title={t.source}
            onClick={() => void updateTheme(appearance === "light" ? { lightTheme: t.id } : { darkTheme: t.id })}
          >
            <ThemePreview theme={t} />
            <span className="theme-card-name">
              {t.name}
              {t.id === active && <span className="theme-card-live">In use</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const STATUSES = ["planning", "in_progress", "blocked", "review", "done"] as const;

/** A tiny board drawn in the theme's own tokens: sidebar, two columns with cards, a primary button. */
export function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <span className="tp" style={previewVars(theme)} aria-hidden>
      <span className="tp-side">
        <span className="tp-nav on" />
        <span className="tp-nav" />
        <span className="tp-nav" />
      </span>
      <span className="tp-main">
        <span className="tp-cols">
          {(["in_progress", "review"] as const).map((s) => (
            <span className="tp-col" key={s}>
              <span className="tp-col-head">
                <span className="tp-dot" style={{ background: `var(--p-c-${s})` }} />
                <span className="tp-line short" />
              </span>
              <span className="tp-card">
                <span className="tp-line" />
                <span className="tp-line dim" />
              </span>
              {s === "review" && (
                <span className="tp-card">
                  <span className="tp-line dim" />
                </span>
              )}
            </span>
          ))}
        </span>
        <span className="tp-foot">
          <span className="tp-dots">
            {STATUSES.map((s) => (
              <span key={s} className="tp-dot" style={{ background: `var(--p-c-${s})` }} />
            ))}
          </span>
          <span className="tp-btn" />
        </span>
      </span>
    </span>
  );
}
