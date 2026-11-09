import { describe, expect, test } from "bun:test"
import { Permit } from "../../src/delegation/permit"

// Gate reconciles tool results by hashing the model's tool-call arguments in
// Python; croakcode hashes the same arguments in TypeScript when it asks for
// the permit. The table is shared with croak gateway/auth/tests/test_permit_core.py.
const PARITY: [unknown, string][] = [
  [{ command: "ls" }, "4cf29611a66934862f29acfcc817e30b905c1ab73d5e65831413eb6b454d49db"],
  [{ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } }, "8280fefe643f84bbeee696cffe0ba03a09974c0b6c325c8e2890d386e245b530"],
  [{ n: 1.0, m: 2.5, neg: -3 }, "060665a8709da3f60738f77f6bbd2b6fc4bd8881b97be14e011a38ff61c918d2"],
  [{ text: '한글 "따옴표" \n줄바꿈 \\ /' }, "4656a21193f397daafb30fdb2cdc4571eb2d5a86c02141f01926be27586afda5"],
  [{ empty: {}, list: [], nul: null, t: true }, "a3849bb2ba1ce30a15c6d237c4be53ac3ae7fb1569de03844fcef4b88d3e234d"],
]

describe("argument hash parity with croak-gate", () => {
  test("TypeScript and Python hash the same arguments the same way", () => {
    for (const [value, expected] of PARITY) expect(Permit.argsHash(value)).toBe(expected)
  })
})
