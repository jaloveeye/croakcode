import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { PermitNonceTable } from "../../src/delegation/delegation.sql"
import { CLOCK_SKEW_MS } from "../../src/delegation/permit"
import { PermitNonce } from "../../src/delegation/permit-nonce"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const NOW = 1_800_000_000_000
const nonce = () => `n_${Math.random().toString(36).slice(2)}`

describe("persistent permit nonces (PT-05)", () => {
  it.instance("a nonce used by one store is refused by a new one, as after a restart", () =>
    Effect.sync(() => {
      const n = nonce()
      expect(new PermitNonce.Store().claim(n, NOW + 30_000, NOW)).toBe(true)
      expect(new PermitNonce.Store().claim(n, NOW + 30_000, NOW + 1_000)).toBe(false)
    }),
  )

  it.instance("expired nonces are deleted once past the clock skew", () =>
    Effect.sync(() => {
      const n = nonce()
      const store = new PermitNonce.Store()
      store.claim(n, NOW, NOW)
      const row = () => Database.use((db) => db.select().from(PermitNonceTable).where(eq(PermitNonceTable.nonce, n)).get())
      store.claim(nonce(), NOW + CLOCK_SKEW_MS, NOW + CLOCK_SKEW_MS)
      expect(row()).toBeDefined()
      store.claim(nonce(), NOW + CLOCK_SKEW_MS + 2, NOW + CLOCK_SKEW_MS + 1)
      expect(row()).toBeUndefined()
    }),
  )
})
