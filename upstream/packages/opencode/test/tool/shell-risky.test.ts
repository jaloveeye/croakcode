import { describe, expect, test } from "bun:test"
import { riskyCommand } from "@/tool/shell"

describe("shell risky forms (Phase 5 Task 7)", () => {
  test("ordinary commands are not risky", async () => {
    for (const command of [
      "ls -la",
      "git status && git diff",
      "grep -rn foo src | head -20",
      "ls > /dev/null 2>&1",
      "find . -name '*.ts' -type f",
      "sed -n '1,20p' file.txt",
      "sed 's/a/b/g' file.txt",
    ]) {
      expect(await riskyCommand(command)).toEqual([])
    }
  })

  test.each([
    ["echo $(cat /etc/passwd)", "runs a command inside another command"],
    ["echo `id`", "runs a command inside another command"],
    ["diff <(ls a) <(ls b)", "runs a command inside another command"],
    ["(cd /tmp && rm -rf x)", "subshell"],
    ["ls > out.txt", "writes output to a file"],
    ["echo hi >> notes.md", "writes output to a file"],
    ["find . -name '*.log' -delete", "find runs a command or deletes files"],
    ["find . -exec rm {} \;", "find runs a command or deletes files"],
    ["sed -i 's/a/b/' file.txt", "sed edits files"],
    ["sed --in-place=.bak 's/a/b/' file.txt", "sed edits files"],
    ["sed 's/a/b/e' file.txt", "sed edits files"],
    ["sed 's/a/b/w out.txt' file.txt", "sed edits files"],
    ["sed -e '1e id' file.txt", "sed edits files"],
    ["sed '$w copy.txt' file.txt", "sed edits files"],
  ])("%s is confirmed with the user", async (command, reason) => {
    const reasons = await riskyCommand(command)
    expect(reasons.some((item) => item.includes(reason))).toBe(true)
  })

  test("a command that does not parse is risky", async () => {
    expect((await riskyCommand("echo 'unterminated")).some((item) => item.includes("could not be parsed"))).toBe(true)
  })
})
