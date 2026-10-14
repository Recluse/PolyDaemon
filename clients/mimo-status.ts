// Independent serial polls: a slow memory check must not delay bridge status.
export function pollMiMoStatus<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (value: T) => void,
  delay: (value: T) => number,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    try {
      const value = await read(controller.signal)
      if (controller.signal.aborted) return
      publish(value)
      timer = setTimeout(refresh, delay(value))
    } catch {
      // Readers normally return explicit unavailable states. A failed refresh
      // still must not permanently stop polling or create unhandled rejections.
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000)
    }
  }
  void refresh()
  return () => { controller.abort(); clearTimeout(timer) }
}
