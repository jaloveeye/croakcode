type Scheduler = {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

type IdleAutoFollowOptions = {
  delayMs: number
  isAtBottom: () => boolean
  isBlocked: () => boolean
  scrollToBottom: () => void
  scheduler?: Scheduler
}

const defaultScheduler: Scheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createIdleAutoFollow(options: IdleAutoFollowOptions) {
  const scheduler = options.scheduler ?? defaultScheduler
  let timer: unknown
  let disposed = false

  const cancel = () => {
    if (timer === undefined) return
    scheduler.clear(timer)
    timer = undefined
  }

  const schedule = () => {
    cancel()
    if (disposed || options.delayMs <= 0 || options.isAtBottom()) return

    timer = scheduler.set(() => {
      timer = undefined
      if (disposed || options.isAtBottom()) return
      if (options.isBlocked()) {
        schedule()
        return
      }
      options.scrollToBottom()
    }, options.delayMs)
  }

  const ensure = () => {
    if (disposed || options.delayMs <= 0) return
    if (options.isAtBottom()) {
      cancel()
      return
    }
    if (timer === undefined) schedule()
  }

  return {
    activity: schedule,
    ensure,
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
