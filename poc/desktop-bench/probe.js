// Identical instrumentation injected before React in every visible window.
// RequestAnimationFrame intervals describe this workload; they are not a claim
// about compositor FPS, dropped frames or input-to-photon latency.
;(() => {
  const run = new URL(location.href).searchParams.get('__bench')
  const report = async (phase, data = {}) => {
    await fetch('/__bench/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run, phase, ...data }),
    })
  }
  const errors = []
  const warnings = []
  addEventListener('error', (event) => {
    if (String(event.message).startsWith('ResizeObserver loop')) {
      warnings.push(String(event.message))
      return
    }
    errors.push({
      message: String(event.message),
      file: event.filename,
      line: event.lineno,
      stack: event.error?.stack,
    })
  })
  addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
  const mounted = () => [...document.querySelectorAll('.diff diffs-container')]
  const titles = () =>
    mounted().map((host) => host.shadowRoot?.querySelector('[data-title]')?.textContent.trim())
  const lines = () =>
    mounted().reduce(
      (sum, host) => sum + (host.shadowRoot?.querySelectorAll('[data-line]').length ?? 0),
      0,
    )
  const highlighted = () => mounted().some((host) => host.shadowRoot?.querySelector('span[style]'))
  const scroller = () => {
    const pane = document.querySelector('.diff')
    return (
      pane &&
      [pane, ...pane.querySelectorAll('*')].find((element) => {
        const style = getComputedStyle(element)
        return (
          ['auto', 'scroll'].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 20
        )
      })
    )
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ready = async () => {
    const empty = location.pathname === '/__bench/empty'
    for (let i = 0; !empty && i < 600; i++) {
      if (
        document
          .querySelector('file-tree-container')
          ?.shadowRoot?.querySelector('[role="treeitem"]') &&
        lines() > 0 &&
        highlighted()
      )
        break
      if (i === 599)
        throw new Error('Diff never rendered: ' + document.body.textContent.slice(0, 200))
      await wait(100)
    }
    await report('ready', {
      renderer_ms: performance.now(),
      viewport: [innerWidth, innerHeight],
      user_agent: navigator.userAgent,
      mounted_files: mounted().length,
      lines: lines(),
      titles: titles(),
      errors, warnings,
    })
    // The harness performs idle sampling first, then explicitly starts load.
    for (;;) {
      const command = await (await fetch('/__bench/control?run=' + run)).json()
      if (command.load) break
      await wait(200)
    }
    if (empty) {
      await report('loaded', { empty: true, errors, warnings })
      return
    }
    const pane = scroller()
    if (!pane) throw new Error('No virtualised diff scroller')
    const start = performance.now()
    let previous = start
    const intervals = []
    const seen = new Set(titles())
    let peakMounted = 0
    await report('load-start')
    await new Promise((resolve) => {
      const frame = (now) => {
        intervals.push(now - previous)
        previous = now
        const fraction = Math.min(1, (now - start) / 5000)
        pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction
        titles().forEach((title) => seen.add(title))
        peakMounted = Math.max(peakMounted, mounted().length)
        if (fraction < 1) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    await wait(1000)
    intervals.sort((a, b) => a - b)
    await report('loaded', {
      raf_p50_ms: intervals[Math.floor(intervals.length * 0.5)],
      raf_p95_ms: intervals[Math.floor(intervals.length * 0.95)],
      raf_max_ms: intervals.at(-1),
      raf_mean_ms: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
      frames_over_50ms: intervals.filter(value => value > 50).length,
      raf_intervals_ms: intervals,
      frames: intervals.length,
      elapsed_ms: performance.now() - start,
      files_seen: seen.size,
      peak_mounted: peakMounted,
      end_titles: titles(),
      scroll_top: pane.scrollTop,
      scroll_height: pane.scrollHeight,
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      errors, warnings,
    })
  }
  ready().catch((error) => report('error', { error: String(error), errors }))
})()
