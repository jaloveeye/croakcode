import { Layer } from "effect"
import { TuiConfig } from "./config/tui"
import { Npm } from "@croakcode/core/npm"
import { Observability } from "@croakcode/core/effect/observability"

export const CliLayer = Observability.layer.pipe(Layer.merge(TuiConfig.layer), Layer.provide(Npm.defaultLayer))
