// Keeps the agent away from keys, certificates and secret files.
//
// Before a tool runs, its target is checked: read, edit, write, list, glob and
// grep paths and patterns, and every path-like word of a bash command. A
// match stops the tool with an error the model can read. After a tool runs,
// lines that name a blocked file (grep "path:line: text", glob and list
// results) are removed from its output.
//
// The same lists are enforced by the Croak gate (policy.yaml deny_paths), so
// a changed local setup still cannot send these files to the model.

/** Folders whose contents are never read. Matched as whole path segments. */
export const DENY_DIRS = Object.freeze([".ssh", ".aws", ".gnupg", ".config/croak"]);
/** File names never read. `*` matches any characters. */
export const DENY_FILES = Object.freeze([".env", "*.env", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*"]);

const toRegex = (glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const FILE_RES = DENY_FILES.map((f) => [f, toRegex(f)]);

/** The rule a path breaks, or null. Works for absolute, relative and ~ paths. */
export function deniedPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const segs = value.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  for (const dir of DENY_DIRS) {
    const parts = dir.split("/");
    for (let i = 0; i + parts.length <= segs.length; i++) {
      if (parts.every((p, j) => segs[i + j] === p)) return dir;
    }
  }
  const base = segs.at(-1) ?? "";
  for (const [glob, re] of FILE_RES) if (re.test(base)) return glob;
  return null;
}

/** Path-like words of a shell command. */
export function commandPaths(command) {
  if (typeof command !== "string") return [];
  return command.split(/[\s"'`;|&<>()=,]+/).filter((w) => w && !w.startsWith("-"));
}

const PATH_ARGS = ["filePath", "path", "file", "include", "pattern", "directory"];

/** The rule the call breaks, or null. */
export function deniedCall(tool, args) {
  if (!args || typeof args !== "object") return null;
  if (tool === "bash") {
    for (const word of commandPaths(args.command)) {
      const rule = deniedPath(word);
      if (rule) return { rule, target: word };
    }
    return null;
  }
  for (const key of PATH_ARGS) {
    const rule = deniedPath(args[key]);
    if (rule) return { rule, target: args[key] };
  }
  return null;
}

/** Output without lines that start with a blocked path (grep, glob, list). */
export function filterOutput(text) {
  if (typeof text !== "string" || !text) return { text, removed: 0 };
  let removed = 0;
  const kept = text.split("\n").filter((line) => {
    const first = line.trim().split(/[:\s]/)[0];
    if (first && deniedPath(first)) {
      removed++;
      return false;
    }
    return true;
  });
  if (removed) kept.push(`[croak] 키, 인증서, 비밀 파일의 줄 ${removed}개를 뺐다.`);
  return { text: kept.join("\n"), removed };
}

export const server = async () => ({
  "tool.execute.before": async (input, output) => {
    const hit = deniedCall(input.tool, output?.args);
    if (hit) {
      throw new Error(
        `[croak] '${hit.target}'은(는) 키, 인증서, 비밀 파일이라 읽을 수 없다 (규칙 ${hit.rule}). 이 파일 없이 작업한다.`,
      );
    }
  },
  "tool.execute.after": async (input, output) => {
    if (!["grep", "glob", "list", "bash"].includes(input.tool)) return;
    const { text, removed } = filterOutput(output.output);
    if (removed) output.output = text;
  },
});

export default { id: "croak-secret-paths", server };
