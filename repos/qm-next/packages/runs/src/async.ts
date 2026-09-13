export const sleep = (ms: number, opts?: { unref?: boolean }): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (opts?.unref) timer.unref?.()
  })
