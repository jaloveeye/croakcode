import fs from "fs"
import * as tty from "node:tty"

export const INTERACTIVE_INPUT_ERROR = "--interactive requires a controlling terminal for input"

type InteractiveStdin = {
  stdin: NodeJS.ReadStream
  cleanup?: () => void
}

function openTerminalStdin(path: string): NodeJS.ReadStream {
  return new tty.ReadStream(fs.openSync(path, "r"))
}

export function resolveInteractiveStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  open: (path: string) => NodeJS.ReadStream = openTerminalStdin,
  platform = process.platform,
): InteractiveStdin {
  if (stdin.isTTY) {
    return { stdin }
  }

  const file = platform === "win32" ? "CONIN$" : "/dev/tty"

  try {
    const stream = open(file)
    return {
      stdin: stream,
      cleanup: () => {
        stream.destroy()
      },
    }
  } catch (error) {
    throw new Error(INTERACTIVE_INPUT_ERROR, { cause: error })
  }
}

/**
 * Whether `cc run` should read piped input from stdin. Only a pipe
 * (`echo ... | cc run`) or a redirected file (`cc run < file`) ends on its
 * own. A socket, a character device or an inherited descriptor from a
 * background job or a CI runner may never reach end of file, and waiting for
 * it hung `cc run` before it sent anything.
 */
export function shouldReadPipedStdin(stat: Pick<fs.Stats, "isFIFO" | "isFile"> | undefined): boolean {
  return stat !== undefined && (stat.isFIFO() || stat.isFile())
}

export function stdinStat(fd = 0): fs.Stats | undefined {
  try {
    return fs.fstatSync(fd)
  } catch {
    return undefined
  }
}
