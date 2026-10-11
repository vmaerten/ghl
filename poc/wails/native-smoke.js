// Injected only by smoke.py into temporary fixture reviews, in the real WebView.
;(async () => {
  if (!location.pathname.startsWith('/r/')) return
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const wait = async (fn, message) => {
    for (let i = 0; i < 300; i++) {
      const value = await fn()
      if (value) return value
      await sleep(100)
    }
    throw new Error(message)
  }
  const api = location.pathname.replace(/\/$/, '') + '/api/'
  const diff = async () => (await fetch(api + 'diff' + location.search)).json()
  const report = async (data) => {
    await fetch(window.smokeCollector, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify(data),
    })
  }
  const host = () => document.querySelector('.diff diffs-container')
  const text = (selector, value) => {
    const area = document.querySelector(selector)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }
  try {
    await wait(() => document.querySelector('.viewed-toggle input'), 'UI never rendered')
    await wait(
      () =>
        host()?.shadowRoot?.querySelector('[data-line]') ||
        document.querySelector('.viewed-toggle input')?.checked,
      'No diff lines',
    )
    check(typeof window.runtime?.ClipboardSetText === 'function', 'No native clipboard runtime')
    const data = await diff()
    const health = await (await fetch('/api/health')).json()
    const name = data.repo.path.split('/').at(-1)
    const minimized = await window.runtime.WindowIsMinimised()
    const baseReport = {
      name,
      pid: health.pid,
      repos: health.repos.length,
      minimized,
      path: location.pathname,
      userAgent: navigator.userAgent,
    }
    if (name === 'second é space') {
      check(data.files[0].path === 'other.txt', 'Second repository not selected')
      await report({ ...baseReport, phase: 'second' })
      return
    }
    if (data.comments.some((c) => c.body === 'persistent desktop fixture')) {
      check('context.txt' in data.viewed, 'Viewed did not persist')
      document.querySelector('.comments-trigger').click()
      await wait(() => document.querySelector('.comments-panel[open]'), 'Panel did not open')
      check(
        document
          .querySelector('.comments-panel')
          .textContent.includes('persistent desktop fixture'),
        'Comment not restored in UI',
      )
      await report({ ...baseReport, phase: 'restored', viewed: true, comment: true })
      return
    }
    let contextRequests = 0
    const realFetch = window.fetch
    window.fetch = (...args) => {
      if (String(args[0]).includes('/api/diff-files')) contextRequests++
      return realFetch(...args)
    }
    await wait(
      () => host()?.shadowRoot?.querySelector('[data-expand-index="1"] [data-expand-up]'),
      'No context expansion control',
    )
    host().shadowRoot.querySelector('[data-expand-index="1"] [data-expand-up]').click()
    const cell = await wait(
      () => host()?.shadowRoot?.querySelector('[data-column-number="20"]'),
      'Context did not expand',
    )
    const bounds = cell.getBoundingClientRect()
    const eventOptions = {
      bubbles: true,
      composed: true,
      pointerType: 'mouse',
      pointerId: 1,
      button: 0,
      clientX: bounds.x + 4,
      clientY: bounds.y + bounds.height / 2,
    }
    cell.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, buttons: 1 }))
    cell.dispatchEvent(new PointerEvent('pointerup', eventOptions))
    document.activeElement?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    await wait(() => document.querySelector('.comment-composer textarea'), 'Composer did not open')
    text('.comment-composer textarea', 'created in native WebView')
    document.querySelector('.comment-composer footer button:last-child').click()
    await wait(
      async () => (await diff()).comments.some((c) => c.body === 'created in native WebView'),
      'UI comment was not saved',
    )
    document.querySelector('.comments-trigger').click()
    await wait(
      () => document.querySelector('.comments-panel[open] .comment-menu-items button'),
      'Comment panel not populated',
    )
    document.querySelector('.comments-panel .comment-menu-items button').click()
    await wait(() => document.querySelector('.panel-editor textarea'), 'Editor not opened')
    text('.panel-editor textarea', 'edited in native WebView')
    await sleep(100)
    document.querySelector('.panel-editor button[type="submit"]').click()
    await wait(
      async () => (await diff()).comments.some((c) => c.body === 'edited in native WebView'),
      'Edit not saved',
    )
    document.querySelector('.comments-panel-toolbar button').click()
    await wait(
      () => document.querySelector('.comments-panel-toolbar button').textContent.includes('Copied'),
      'Copy failed',
    )
    const clipboard = await navigator.clipboard.readText()
    check(
      clipboard.includes('edited in native WebView') && clipboard.includes('line 20'),
      'Native clipboard lacks Markdown/code',
    )
    document.querySelector('.comments-panel .danger-action').click()
    await wait(async () => (await diff()).comments.length === 0, 'Delete not saved')
    document.querySelector('[aria-label="Close comments"]').click()
    const fresh = await diff()
    const response = await fetch(api + 'comments' + location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'persistent-fixture',
        path: 'context.txt',
        range: fresh.range,
        side: 'additions',
        start: 10,
        end: 10,
        body: 'persistent desktop fixture',
      }),
    })
    check(response.ok, 'Persistence fixture did not save')
    document.querySelector('.viewed-toggle input').click()
    await wait(async () => 'context.txt' in (await diff()).viewed, 'Viewed not saved')
    check(contextRequests > 0, 'Context did not use the API')
    await report({
      ...baseReport,
      phase: 'initial',
      created: true,
      edited: true,
      deleted: true,
      clipboard,
      contextRequests,
      viewed: true,
    })
    window.runtime.WindowMinimise()
  } catch (error) {
    await report({
      phase: 'error',
      error: String(error),
      text: document.body.textContent.slice(0, 2000),
      path: location.pathname,
    })
  }
})()
