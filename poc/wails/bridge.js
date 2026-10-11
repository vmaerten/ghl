// Only injected inside the prototype's Wails document. Browser UI is unchanged.
;(() => {
  if (!window.runtime?.ClipboardSetText) throw new Error('Desktop runtime is missing')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        const copied = await window.runtime.ClipboardSetText(String(text))
        if (!copied) throw new Error('Native clipboard refused the copy')
      },
      readText: () => window.runtime.ClipboardGetText(),
    },
  })
  const replace = history.replaceState.bind(history)
  history.replaceState = (...args) => {
    replace(...args)
    window.dispatchEvent(new Event('desktop:selection'))
  }
})()
