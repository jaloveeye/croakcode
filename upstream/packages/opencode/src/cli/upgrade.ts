// croakcode never checks for or installs updates through upstream's channels
// (see Installation.UPGRADE_DISABLED). The gate check runs before CLI startup.
export async function upgrade() {}
