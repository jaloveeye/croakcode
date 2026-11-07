declare global {
  const CROAKCODE_VERSION: string
  const CROAKCODE_CHANNEL: string
}

export const InstallationVersion = typeof CROAKCODE_VERSION === "string" ? CROAKCODE_VERSION : "local"
export const InstallationChannel = typeof CROAKCODE_CHANNEL === "string" ? CROAKCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
