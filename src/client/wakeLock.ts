export interface WakeLockHandle {
  release: () => Promise<void>
}

export async function acquireScreenWakeLock(): Promise<WakeLockHandle | null> {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockHandle> } }).wakeLock
  if (!wakeLock?.request) return null
  try {
    return (await wakeLock.request('screen')) as WakeLockHandle
  } catch {
    return null
  }
}

export async function releaseScreenWakeLock(handle: WakeLockHandle | null | undefined): Promise<void> {
  if (!handle) return
  try {
    await handle.release()
  } catch {
    // Ignore release failures if the browser already dropped the lock.
  }
}

export function supportsScreenWakeLock(): boolean {
  return Boolean((navigator as Navigator & { wakeLock?: { request?: unknown } }).wakeLock?.request)
}
