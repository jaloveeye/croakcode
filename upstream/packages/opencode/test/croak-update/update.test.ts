import { describe, expect, test } from "bun:test"
import { classify, entryFor, parseManifest } from "../../src/croak-update"

const hash = "a".repeat(64)
const manifest = parseManifest({
  product: "croakcode",
  latest: "1.2.0",
  minimum: "1.1.0",
  files: {
    "linux-x64": { file: "croakcode-1.2.0-linux-x64.tar.gz", sha256: hash, size: 123 },
    "windows-x64": { file: "croakcode-1.2.0-windows-x64.zip", sha256: hash, size: 123 },
  },
})

describe("gate update policy", () => {
  test("classifies current, optional and required versions", () => {
    expect(classify(manifest, "1.2.0").kind).toBe("current")
    expect(classify(manifest, "1.1.0").kind).toBe("optional")
    expect(classify(manifest, "1.0.9").kind).toBe("required")
    expect(classify(manifest, "1.1.0-dev.abc").kind).toBe("required")
  })

  test("rejects invalid policy and archive paths", () => {
    expect(() => parseManifest({ ...manifest, minimum: "1.3.0" })).toThrow()
    expect(() => parseManifest({ ...manifest, latest: "1.2.0-dev.abc" })).toThrow()
    expect(() => entryFor({ ...manifest, files: { "linux-x64": { file: "../file", sha256: hash, size: 1 } } }, "linux", "x64")).toThrow()
    expect(() => entryFor(manifest, "win32", "arm64")).toThrow()
    expect(entryFor(manifest, "win32", "x64").file).toBe("croakcode-1.2.0-windows-x64.zip")
  })
})
