import { expect, test } from "bun:test"
import { togglePermissionMode } from "@/cli/permission-mode"

test("permission mode toggles between prompts and automatic approval", () => {
  expect(togglePermissionMode("ask")).toBe("auto")
  expect(togglePermissionMode("auto")).toBe("ask")
})
