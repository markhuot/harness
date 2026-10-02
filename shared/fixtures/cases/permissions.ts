// Permission-mode resolution (shared/src/permissions.ts) for HarnessKit's Permissions.swift.
import type * as P from "../../src/protocol";
import { PERMISSION_MODE_LABELS, resolvePermissionMode } from "../../src/permissions";
import { cases } from "../case";
import { Project as projectSamples, Settings as settingsSamples, Ticket as ticketSamples } from "./protocol";

type ModeRef = { permissionMode: P.PermissionMode | null } | null;

export const resolvePermissionModeCases = cases(
  ({ ticket, project, settings }: { ticket: ModeRef; project: ModeRef; settings: { permissionMode: P.PermissionMode } }) =>
    resolvePermissionMode(ticket, project, settings),
  {
    "ticket beats project": { ticket: { permissionMode: "read_only" }, project: { permissionMode: "ask" }, settings: { permissionMode: "auto" } },
    "null ticket inherits project": { ticket: { permissionMode: null }, project: { permissionMode: "ask" }, settings: { permissionMode: "auto" } },
    "both null: settings": { ticket: { permissionMode: null }, project: { permissionMode: null }, settings: { permissionMode: "auto" } },
    "no ticket or project": { ticket: null, project: null, settings: { permissionMode: "ask" } },
    "ticket without project": { ticket: { permissionMode: "auto" }, project: null, settings: { permissionMode: "read_only" } },
    "project without ticket": { ticket: null, project: { permissionMode: "read_only" }, settings: { permissionMode: "auto" } },
    // A newer service's mode is passed through, not dropped.
    "unknown ticket mode kept": { ticket: { permissionMode: "yolo" as P.PermissionMode }, project: { permissionMode: "ask" }, settings: { permissionMode: "auto" } },
    "unknown settings mode kept": { ticket: null, project: null, settings: { permissionMode: "paranoid" as P.PermissionMode } },
    // "" is falsy in JS, so it inherits like null.
    "empty ticket mode inherits": { ticket: { permissionMode: "" as P.PermissionMode }, project: { permissionMode: "ask" }, settings: { permissionMode: "auto" } },
    "empty project mode inherits": { ticket: null, project: { permissionMode: "" as P.PermissionMode }, settings: { permissionMode: "read_only" } },
  },
);

const [fullTicket, plainTicket] = ticketSamples as [P.Ticket, P.Ticket];
const [fullProject, plainProject] = projectSamples as [P.Project, P.Project];
const [fullSettings, plainSettings] = settingsSamples as [P.Settings, P.Settings];

export const resolvePermissionModeEntityCases = cases(
  ({ ticket, project, settings }: { ticket: P.Ticket | null; project: P.Project | null; settings: P.Settings }) =>
    resolvePermissionMode(ticket, project, settings),
  {
    "ticket override": { ticket: fullTicket, project: fullProject, settings: fullSettings },
    "project override": { ticket: plainTicket, project: fullProject, settings: fullSettings },
    "settings": { ticket: plainTicket, project: plainProject, settings: plainSettings },
    "no ticket": { ticket: null, project: plainProject, settings: fullSettings },
  },
);

export const permissionModeLabels = PERMISSION_MODE_LABELS;
