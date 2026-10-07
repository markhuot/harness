import type { Database } from "bun:sqlite";
import type { ApnsEnvironment, Device, DevicePlatform } from "@harness/shared";
import { now } from "./util";

/** A registered device with its APNs token (never sent to clients; Device has only its suffix). */
export interface DeviceRecord extends Device {
  apnsToken: string;
}

interface Row {
  id: string;
  platform: string;
  name: string;
  apns_token: string;
  topic: string;
  environment: string;
  created_at: number;
  last_seen: number;
}

const toRecord = (r: Row): DeviceRecord => ({
  id: r.id,
  platform: r.platform as DevicePlatform,
  name: r.name,
  apnsToken: r.apns_token,
  topic: r.topic,
  environment: r.environment as ApnsEnvironment,
  tokenSuffix: r.apns_token.slice(-8),
  createdAt: r.created_at,
  lastSeen: r.last_seen,
});

/** The device as clients see it: everything but the token. */
export function publicDevice({ apnsToken: _token, ...device }: DeviceRecord): Device {
  return device;
}

/** Devices registered for push notifications. */
export class DeviceRepo {
  constructor(private db: Database) {}

  list(): DeviceRecord[] {
    return (this.db.query("SELECT * FROM devices ORDER BY created_at").all() as Row[]).map(toRecord);
  }

  get(id: string): DeviceRecord | null {
    const row = this.db.query("SELECT * FROM devices WHERE id = $id").get({ id }) as Row | null;
    return row ? toRecord(row) : null;
  }

  /**
   * Add the device or update it. A token belongs to one install, so another row holding the same
   * token (the app was reinstalled and picked a new id) is replaced.
   */
  upsert(d: { id: string; platform: DevicePlatform; name: string; apnsToken: string; topic: string; environment: ApnsEnvironment }): DeviceRecord {
    const t = now();
    this.db.transaction(() => {
      this.db.query("DELETE FROM devices WHERE apns_token = $token AND id != $id").run({ token: d.apnsToken, id: d.id });
      this.db
        .query(
          `INSERT INTO devices (id, platform, name, apns_token, topic, environment, created_at, last_seen)
           VALUES ($id, $platform, $name, $token, $topic, $env, $t, $t)
           ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, name = excluded.name, apns_token = excluded.apns_token,
             topic = excluded.topic, environment = excluded.environment, last_seen = excluded.last_seen`,
        )
        .run({ id: d.id, platform: d.platform, name: d.name, token: d.apnsToken, topic: d.topic, env: d.environment, t });
    })();
    return this.get(d.id)!;
  }

  /** Remove a device; false when there was none. */
  delete(id: string): boolean {
    return this.db.query("DELETE FROM devices WHERE id = $id").run({ id }).changes > 0;
  }

  /** Remove the device holding this token (APNs said it's no longer valid). */
  deleteByToken(token: string): boolean {
    return this.db.query("DELETE FROM devices WHERE apns_token = $token").run({ token }).changes > 0;
  }
}
