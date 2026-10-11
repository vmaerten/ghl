;(() => {
  let active = ''
  let sequence = 0
  const send = (data) =>
    fetch(window.collector, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) })
  const inspect = (s) => {
    if (!s.active || s.active === active) return
    active = s.active
    const id = active
    const turn = ++sequence
    ;(async () => {
      const tab = s.tabs.find((t) => t.id === id)
      for (let i = 0; i < 300; i++) {
        if (
          document.querySelector('.desktop-review')?.dataset.activeTab === id &&
          document.querySelector('.repo-name')?.textContent === tab.name &&
          document.querySelector('.diff diffs-container')?.shadowRoot?.querySelector('[data-line]')
        )
          break
        if (i === 299) throw new Error('render timeout')
        await new Promise((r) => setTimeout(r, 100))
      }
      await new Promise((r) => setTimeout(r, 1000))
      await send({
        phase: 'ready',
        sequence: turn,
        id,
        tabs: s.tabs.length,
        views: document.querySelectorAll('.app').length,
        viewBytes: s.tabs.reduce((n, t) => n + JSON.stringify(t.view ?? {}).length, 0),
        pid: (await (await fetch('/api/health')).json()).pid,
      })
    })().catch((e) => send({ phase: 'error', error: String(e) }))
  }
  window.runtime.EventsOn('desktop:tabs', inspect)
  window.go.main.desktopApp.Tabs().then(inspect)
})()
