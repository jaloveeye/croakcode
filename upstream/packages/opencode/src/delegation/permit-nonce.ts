import { lt } from "drizzle-orm"
import { Database } from "@/storage/db"
import { PermitNonceTable } from "./delegation.sql"
import { CLOCK_SKEW_MS, type Nonces } from "./permit"

// Used permit nonces in the database (PT-05). The in-memory NonceStore
// forgets them on restart; this one does not, and the primary key makes a
// claim atomic across processes that share the database.

export class Store implements Nonces {
  claim(nonce: string, exp: number, now: number): boolean {
    return Database.use((db) => {
      db.delete(PermitNonceTable).where(lt(PermitNonceTable.exp, now - CLOCK_SKEW_MS)).run()
      const inserted = db
        .insert(PermitNonceTable)
        .values({ nonce, exp })
        .onConflictDoNothing()
        .returning({ nonce: PermitNonceTable.nonce })
        .all()
      return inserted.length === 1
    })
  }
}

export * as PermitNonce from "./permit-nonce"
