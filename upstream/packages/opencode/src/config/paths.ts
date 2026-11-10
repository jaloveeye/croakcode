export * as ConfigPaths from "./paths"

import path from "path"
import { existsSync, realpathSync } from "fs"
import { Flag } from "@croakcode/core/flag/flag"
import { Global } from "@croakcode/core/global"
import { uniqueBy } from "remeda"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@croakcode/core/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  // A folder reached twice (e.g. ~/.croakcode linked to a project's
  // .croakcode) is loaded once, so its plugins do not run twice.
  return uniqueBy(
    [
      Global.Path.config,
      ...(!Flag.CROAKCODE_DISABLE_PROJECT_CONFIG
        ? yield* afs.up({
            targets: [".croakcode"],
            start: directory,
            stop: worktree,
          })
        : []),
      ...(yield* afs.up({
        targets: [".croakcode"],
        start: Global.Path.home,
        stop: Global.Path.home,
      })),
      ...(Flag.CROAKCODE_CONFIG_DIR ? [Flag.CROAKCODE_CONFIG_DIR] : []),
    ],
    (dir) => (existsSync(dir) ? realpathSync(dir) : dir),
  )
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
