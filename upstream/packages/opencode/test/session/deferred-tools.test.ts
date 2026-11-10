import { describe, expect, test } from "bun:test"
import { jsonSchema, type Tool, type ToolExecutionOptions } from "ai"
import { deferTools } from "../../src/session/tools"

const calls: string[] = []
const make = (name: string, description: string) =>
  ({
    description,
    inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
    async execute(args: { value?: string }) {
      calls.push(`${name}:${args.value ?? ""}`)
      return { title: name, output: `ran ${name}`, metadata: {} }
    },
  }) as unknown as Tool
const options = { toolCallId: "call_1", messages: [] } as unknown as ToolExecutionOptions

const tools = {
  read: make("read", "Read a file"),
  bash: make("bash", "Run a shell command"),
  webfetch: make("webfetch", "Fetch a URL and return its content"),
  todowrite: make("todowrite", "Write the todo list"),
}

describe("deferred tools (Phase 5 Task 8)", () => {
  test("only core tools plus tool_search and tool_call are sent", () => {
    expect(Object.keys(deferTools(tools)).toSorted()).toEqual(["bash", "read", "tool_call", "tool_search"])
  })

  test("tool_search lists the hidden tools and returns their definitions", async () => {
    const visible = deferTools(tools)
    expect(visible.tool_search.description).toContain("- webfetch: Fetch a URL")
    const found = await visible.tool_search.execute!({ query: "fetch url" }, options)
    expect(String(found)).toContain('<tool name="webfetch">')
    expect(String(found)).not.toContain('<tool name="todowrite">')
  })

  test("tool_call runs the hidden tool through its own execute", async () => {
    const visible = deferTools(tools)
    const result = await visible.tool_call.execute!({ name: "todowrite", input: { value: "plan" } }, options)
    expect(result).toEqual({ title: "todowrite", output: "ran todowrite", metadata: {} })
    expect(calls).toContain("todowrite:plan")
  })

  test("tool_call refuses a tool that is not hidden or unknown", async () => {
    const visible = deferTools(tools)
    await expect(visible.tool_call.execute!({ name: "nope", input: {} }, options)).rejects.toThrow("tool_search")
  })

  test("a failed tool_call with a guessed parameter name gets the definition", async () => {
    const strict = {
      ...tools,
      hwp_read: {
        description: "Read an HWP document",
        inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
        async execute(args: { path?: string }) {
          calls.push(`hwp_read:${args.path ?? ""}`)
          if (!args.path) throw new Error("path가 비어 있다.")
          return "read"
        },
      } as unknown as Tool,
    }
    const visible = deferTools(strict)
    const wrong = visible.tool_call.execute!({ name: "hwp_read", input: { filePath: "a.hwp" } }, options)
    await expect(wrong).rejects.toThrow("missing path; unknown filePath (path가 비어 있다.)")
    await expect(visible.tool_call.execute!({ name: "hwp_read", input: { filePath: "a.hwp" } }, options)).rejects.toThrow(
      '<tool name="hwp_read">',
    )
    // The tool itself ran (and got its permit) before the definition was added.
    expect(calls).toContain("hwp_read:")
    expect(await visible.tool_call.execute!({ name: "hwp_read", input: { path: "a.hwp" } }, options)).toBe("read")
  })

  test("nothing changes when every tool is a core tool", () => {
    const core = { read: tools.read, bash: tools.bash }
    expect(deferTools(core)).toBe(core)
  })
})
