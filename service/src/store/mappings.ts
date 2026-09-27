import type { Database } from "bun:sqlite";
import type { Mapping } from "@harness/shared";
import { newId, now } from "./util";

interface MappingRow {
  id: string;
  pattern: string;
  project_id: string;
  notes: string;
  created_at: number;
}

const toMapping = (r: MappingRow): Mapping => ({ id: r.id, pattern: r.pattern, projectId: r.project_id, notes: r.notes, createdAt: r.created_at });

export class MappingRepo {
  constructor(private db: Database) {}

  list(): Mapping[] {
    return (this.db.query("SELECT * FROM mappings ORDER BY created_at, rowid").all() as MappingRow[]).map(toMapping);
  }

  get(id: string): Mapping | null {
    const r = this.db.query("SELECT * FROM mappings WHERE id = $id").get({ id }) as MappingRow | null;
    return r ? toMapping(r) : null;
  }

  create(input: { pattern: string; projectId: string; notes?: string }): Mapping {
    const id = newId();
    this.db
      .query("INSERT INTO mappings (id, pattern, project_id, notes, created_at) VALUES ($id, $pattern, $projectId, $notes, $t)")
      .run({ id, pattern: input.pattern, projectId: input.projectId, notes: input.notes ?? "", t: now() });
    return this.get(id)!;
  }

  delete(id: string) {
    this.db.query("DELETE FROM mappings WHERE id = $id").run({ id });
  }
}
