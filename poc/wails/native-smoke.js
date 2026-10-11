// Injected only by smoke.py into temporary fixture reviews, in the real WebView.
;(() => {
  const run = async (tabId) => {
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
    await wait(
      () => document.querySelector('.desktop-review')?.dataset.activeTab === tabId,
      'Tab never mounted',
    )
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
      const tabState = await window.go.main.desktopApp.Tabs()
      const expected = tabState.tabs.find((tab) => tab.id === tabId)
      await wait(
        () => document.querySelector('.repo-name')?.textContent === expected.name,
        'Wrong review rendered',
      )
      await wait(() => document.querySelector('.viewed-toggle input'), 'UI never rendered')
      check(document.querySelectorAll('.app').length === 1, 'Inactive React reviews stay mounted')
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
        tabs: tabState.tabs.length,
        tabId,
        mountedReviews: document.querySelectorAll('.app').length,
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
        if (window.smokeSecondAgain)
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }),
          )
        window.smokeSecondAgain = true
        return
      }
      if (data.comments.some((c) => c.body === 'persistent desktop fixture')) {
        check('context.txt' in data.viewed, 'Viewed did not persist')
        if (health.repos.length > 1) {
          await wait(
            () =>
              document.querySelector('.comment-composer textarea')?.value ===
              'draft survives desktop tabs',
            'Inline draft not restored',
          )
          await sleep(700)
          const pane = [...document.querySelector('.diff').querySelectorAll('*')].find(
            (el) =>
              ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
              el.scrollHeight > el.clientHeight,
          )
          check(
            pane && Math.abs(pane.scrollTop - expected.view.scrollTop) < 8,
            'Scroll not restored: ' + pane?.scrollTop + ' expected ' + expected.view.scrollTop,
          )
          check(
            document.querySelector('.comment-composer .comment-lines').textContent.includes('20'),
            'Context anchor not restored',
          )
        }
        if (!document.querySelector('.comments-panel[open]'))
          document.querySelector('.comments-trigger').click()
        await wait(() => document.querySelector('.comments-panel[open]'), 'Panel did not open')
        check(
          document
            .querySelector('.comments-panel')
            .textContent.includes('persistent desktop fixture') ||
            document.querySelector('.panel-editor textarea')?.value === 'panel draft survives',
          'Comment not restored in UI',
        )
        if (health.repos.length > 1 && expected.view?.panelEditor?.editing) {
          await wait(
            () =>
              document.querySelector('.panel-editor textarea')?.value === 'panel draft survives',
            'Panel draft not restored',
          )
          const flag = 'ghl-smoke-reload:' + api
          if (!sessionStorage.getItem(flag)) {
            sessionStorage.setItem(flag, '1')
            await report({ ...baseReport, phase: 'restored-editor', panelDraft: true })
            window.dispatchEvent(new Event('desktop:reload'))
            return
          }
          sessionStorage.removeItem(flag)
          await report({ ...baseReport, phase: 'reloaded-editor', panelDraft: true })
          return
        }
        if (health.repos.length > 1) {
          document.querySelector('.comments-panel .comment-menu-items button').click()
          await wait(
            () => document.querySelector('.panel-editor textarea'),
            'Panel editor unavailable',
          )
          text('.panel-editor textarea', 'panel draft survives')
          await sleep(100)
        }
        await report({
          ...baseReport,
          phase: 'restored',
          viewed: true,
          comment: true,
          draft: health.repos.length > 1,
          viewBytes: JSON.stringify(expected.view ?? {}).length,
        })
        if (health.repos.length === 1) document.querySelector('.desktop-tab-close').click()
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
      await wait(
        () => document.querySelector('.comment-composer textarea'),
        'Composer did not open',
      )
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
        () =>
          document.querySelector('.comments-panel-toolbar button').textContent.includes('Copied'),
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
      // Leave a draft on expanded context, not on a changed line.
      const draftCell = host().shadowRoot.querySelector('[data-column-number="20"]')
      const draftBounds = draftCell.getBoundingClientRect()
      const draftEvents = {
        ...eventOptions,
        clientX: draftBounds.x + 4,
        clientY: draftBounds.y + draftBounds.height / 2,
      }
      draftCell.dispatchEvent(new PointerEvent('pointerdown', { ...draftEvents, buttons: 1 }))
      draftCell.dispatchEvent(new PointerEvent('pointerup', draftEvents))
      document.activeElement?.blur()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
      await wait(
        () => document.querySelector('.comment-composer textarea'),
        'Draft composer not opened',
      )
      text('.comment-composer textarea', 'draft survives desktop tabs')
      await sleep(100)
      document.querySelector('.viewed-toggle input').click()
      await wait(async () => 'context.txt' in (await diff()).viewed, 'Viewed not saved')
      const scrollPane = [...document.querySelector('.diff').querySelectorAll('*')].find(
        (el) =>
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight,
      )
      check(scrollPane, 'No scroll pane for session')
      scrollPane.scrollTop = 260
      await sleep(500)
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
  }
  let active = ''
  let completed = false
  let duplicateClosed = false
  const report = (data) =>
    fetch(window.smokeCollector, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) })
  const inspect = (state) => {
    if (!state.active) {
      if (active)
        setTimeout(async () => {
          await report({
            phase: 'empty',
            tabs: state.tabs.length,
            mountedReviews: document.querySelectorAll('.app').length,
            welcome: Boolean(document.querySelector('.desktop-empty')),
          })
        }, 100)
      active = ''
      return
    }
    if (state.active === active) {
      if (completed)
        void report({
          phase: 'same-tab',
          tabs: state.tabs.length,
          tabId: state.active,
          mountedReviews: document.querySelectorAll('.app').length,
        }).then(() => {
          const tab = state.tabs.find((tab) => tab.id === state.active)
          if (tab?.name === 'second é space' && !duplicateClosed) {
            duplicateClosed = true
            document.querySelector('[aria-label="Close second é space"]').click()
          }
        })
      return
    }
    active = state.active
    completed = false
    void run(state.active)
      .then(() => {
        completed = true
      })
      .catch((error) => report({ phase: 'error', error: String(error) }))
  }
  window.runtime.EventsOn('desktop:tabs', inspect)
  void window.go.main.desktopApp.Tabs().then(inspect)
})()
