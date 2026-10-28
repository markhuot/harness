import type { Database } from "bun:sqlite";
import { defaultLabelColor, labelKey, normalizeLabelNames, type LabelInfo } from "@harness/shared";
import { newId } from "./util";
import { type Clock, systemClock } from "../clock";

interface LabelRow {
  id: string;
  name: string;
  color: string;
  created_at: number;
  last_used_at: number;
  count: number;
}

/** Labels (DESIGN.md "Labels"): the registry every project shares and the join to tickets. */
export class LabelRepo {
  constructor(
    private db: Database,
    private now: Clock = systemClock,
  ) {}

  /** Every label, most recently added to a ticket first, with its count of tickets in any status (done included; not drafts or chief-of-staff tickets). */
  list(): LabelInfo[] {
    const rows = this.db
      .query(
        `SELECT l.id, l.name, l.color, l.created_at, l.last_used_at,
           (SELECT COUNT(*) FROM ticket_labels tl JOIN tickets t ON t.id = tl.ticket_id
             WHERE tl.label_id = l.id AND t.kind <> 'cos' AND t.draft = 0) AS count
         FROM labels l ORDER BY l.last_used_at DESC, l.created_at DESC, l.key`,
      )
      .all() as LabelRow[];
    return rows.map((r) => ({ name: r.name, color: r.color, createdAt: r.created_at, lastUsedAt: r.last_used_at, count: r.count }));
  }

  /** The label with this name (case-insensitive), as its stored name, or null. */
  find(name: string): { id: string; name: string; color: string } | null {
    return (this.db.query("SELECT id, name, color FROM labels WHERE key = $key").get({ key: labelKey(name) }) as { id: string; name: string; color: string } | null) ?? null;
  }

  /** A ticket's label names, in the order it got them, by ticket id. */
  namesFor(ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = this.db
      .query(
        `SELECT tl.ticket_id AS ticket_id, l.name AS name FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE tl.ticket_id IN (${ids.map(() => "?").join(",")}) ORDER BY tl.rowid`,
      )
      .all(...ids) as { ticket_id: string; name: string }[];
    for (const r of rows) {
      const list = out.get(r.ticket_id) ?? [];
      list.push(r.name);
      out.set(r.ticket_id, list);
    }
    return out;
  }

  /**
   * Make these the ticket's labels. Names are normalized and de-duplicated (see normalizeLabelNames);
   * one that matches an existing label (any case) uses it, a new one is created with a color derived
   * from its name. Labels the ticket keeps stay in place, new ones follow in the order given, and
   * each one added is stamped as just used. Labels left with no tickets stay, so their color survives.
   * `changed` says whether the ticket's labels or the collection's order or counts moved.
   */
  setForTicket(ticketId: string, names: readonly string[]): { labels: string[]; added: string[]; removed: string[]; changed: boolean } {
    const wanted = normalizeLabelNames(names);
    const wantedKeys = new Set(wanted.map(labelKey));
    const current = this.namesFor([ticketId]).get(ticketId) ?? [];
    const currentKeys = new Set(current.map(labelKey));
    const removed = current.filter((n) => !wantedKeys.has(labelKey(n)));
    const added: string[] = [];
    this.db.transaction(() => {
      for (const name of removed) {
        this.db.query("DELETE FROM ticket_labels WHERE ticket_id = $ticketId AND label_id = (SELECT id FROM labels WHERE key = $key)").run({ ticketId, key: labelKey(name) });
      }
      const t = this.now();
      for (const name of wanted) {
        if (currentKeys.has(labelKey(name))) continue;
        const label = this.find(name) ?? this.create(name, t);
        this.db.query("INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($ticketId, $labelId)").run({ ticketId, labelId: label.id });
        this.db.query("UPDATE labels SET last_used_at = $t WHERE id = $id").run({ id: label.id, t });
        added.push(label.name);
      }
    })();
    return { labels: this.namesFor([ticketId]).get(ticketId) ?? [], added, removed, changed: added.length > 0 || removed.length > 0 };
  }

  private create(name: string, t: number): { id: string; name: string; color: string } {
    const row = { id: newId(), name, color: defaultLabelColor(name) };
    this.db
      .query("INSERT INTO labels (id, name, key, color, created_at, last_used_at) VALUES ($id, $name, $key, $color, $t, $t)")
      .run({ ...row, key: labelKey(name), t });
    return row;
  }

  /** Recolor a label; null when no label has this name. */
  setColor(name: string, color: string): LabelInfo | null {
    const found = this.find(name);
    if (!found) return null;
    this.db.query("UPDATE labels SET color = $color WHERE id = $id").run({ id: found.id, color });
    return this.list().find((l) => labelKey(l.name) === labelKey(name)) ?? null;
  }
}
