// croakcode never checks for or installs updates through upstream's channels
// (see Installation.UPGRADE_DISABLED). The TUI still calls this at start; the
// gate-based update check replaces it in Phase 6 Task 5.
export async function upgrade() {}
