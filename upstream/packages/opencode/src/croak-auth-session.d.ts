// The croak login session lives in the config directory next to the plugins
// that use it (`upstream/.croakcode/plugins/lib/croak-auth-session.js`).
// `tsgo --noEmit` does not follow imports that leave the package root, so the
// runtime side declares the part it uses here. Keep it in sync with the file.
declare module "*/croak-auth-session.js" {
  /** The access token to send, refreshed when close to expiry; null when not logged in. */
  export function accessToken(now?: number): Promise<string | null>
}
