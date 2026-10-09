import { normalizeCoupon, normalizeHandle, type CreatorDirectory } from "../domain/attribution.ts";
import type { Db } from "../db.ts";

export function sqliteDirectory(db: Db): CreatorDirectory {
  return {
    byCoupon: (code) => db.get<{ creator_id: string }>("SELECT creator_id FROM creator_coupons WHERE code = ?", code)?.creator_id ?? null,
    byHandle: (handle) => db.get<{ creator_id: string }>("SELECT creator_id FROM creator_handles WHERE handle = ?", handle)?.creator_id ?? null,
  };
}

export interface CreatorSeed {
  id: string;
  name: string;
  coupons: string[];
  handles: string[];
}

/** Idempotent; a coupon or handle already owned by someone else is left alone. */
export function seedCreators(db: Db, creators: readonly CreatorSeed[]): void {
  db.transaction(() => {
    for (const creator of creators) {
      db.run("INSERT OR IGNORE INTO creators (id, name) VALUES (?, ?)", creator.id, creator.name);
      for (const coupon of creator.coupons) {
        db.run("INSERT OR IGNORE INTO creator_coupons (code, creator_id) VALUES (?, ?)", normalizeCoupon(coupon), creator.id);
      }
      for (const handle of creator.handles) {
        db.run("INSERT OR IGNORE INTO creator_handles (handle, creator_id) VALUES (?, ?)", normalizeHandle(handle), creator.id);
      }
    }
  });
}

export function findCreator(db: Db, id: string): { id: string; name: string } | undefined {
  return db.get("SELECT id, name FROM creators WHERE id = ?", id);
}
