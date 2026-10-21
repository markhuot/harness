import type { Database } from "bun:sqlite";
import type { Cos, CosScope } from "@harness/shared";
import { cosScopeKey, parseCosScopeKey } from "@harness/shared";
import { bool, int } from "./util";
import { type Clock, systemClock } from "../clock";

interface CosRow {
  ticket_id: string;
  key: string;
  scope: string;
  group_id: string | null;
  enabled: number;
  created_at: number;
}

const SELECT = "SELECT c.*, t.key AS key FROM cos c JOIN tickets t ON t.id = c.ticket_id";

const toCos = (r: CosRow): Cos => ({
  ticketId: r.ticket_id,
  key: r.key,
  scope: r.scope as Cos["scope"],
  groupId: r.group_id,
  enabled: bool(r.enabled),
  createdAt: r.created_at,
});

/**
 * Chiefs of staff (DESIGN.md "Chief of staff"): one row per scope, pointing at the ticket (kind
 * "cos") that is the chief's session. The orchestrator makes the ticket; this repo only records it.
 */
export class CosRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  list(): Cos[] {
    return (this.db.query(`${SELECT} ORDER BY c.created_at, c.scope`).all() as CosRow[]).map(toCos);
  }

  get(ticketId: string): Cos | null {
    const r = this.db.query(`${SELECT} WHERE c.ticket_id = $ticketId`).get({ ticketId }) as CosRow | null;
    return r ? toCos(r) : null;
  }

  getByScope(scope: CosScope): Cos | null {
    const r = this.db.query(`${SELECT} WHERE c.scope = $scope`).get({ scope: cosScopeKey(scope) }) as CosRow | null;
    return r ? toCos(r) : null;
  }

  /** Record `ticketId` as the chief of staff of `scope`. The scope is unique: a second one fails. */
  insert(ticketId: string, scope: CosScope): Cos {
    const group = parseCosScopeKey(cosScopeKey(scope));
    this.db
      .query("INSERT INTO cos (ticket_id, scope, group_id, enabled, created_at) VALUES ($ticketId, $scope, $groupId, 1, $t)")
      .run({ ticketId, scope: cosScopeKey(scope), groupId: group && group !== "all" ? group.group : null, t: this.now() });
    return this.get(ticketId)!;
  }

  setEnabled(ticketId: string, enabled: boolean): Cos | null {
    this.db.query("UPDATE cos SET enabled = $enabled WHERE ticket_id = $ticketId").run({ ticketId, enabled: int(enabled) });
    return this.get(ticketId);
  }
}
