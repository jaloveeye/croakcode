import { InstallationVersion } from "@croakcode/core/installation/version"

// Source-only integration tests may identify their test client explicitly.
export function clientVersion() {
  return InstallationVersion === "local" ? process.env.CROAKCODE_DEV_CLIENT_VERSION || InstallationVersion : InstallationVersion
}
