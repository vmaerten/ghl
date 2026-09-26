import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoIdFor } from '../../src/server.ts'
import { clickTreeRow, DIFF_ON_SCREEN, sleep, type Suite } from '../harness.ts'

export default {
  name: 'catalog-ui',
  async run({ page, load, repoPath, url }, check) {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-navigation-')))
    const linked = join(temporary, 'linked')
    const undiscovered = join(temporary, 'another repo')
    const stale = join(repoPath, 'stale-worktrees')
    const terraform = join(repoPath, '.terraform')
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' })
    git('worktree', 'add', '-qb', 'catalog-linked', linked, 'feature')
    git('clone', '-q', repoPath, undiscovered)
    git('clone', '-q', repoPath, join(terraform, 'modules', 'eks.eks.kms'))
    for (const name of ['first', 'second']) {
      mkdirSync(join(stale, name), { recursive: true })
      writeFileSync(join(stale, name, '.git'), 'gitdir: ../../missing-git-metadata\n')
    }
    try {
      await page.goto(new URL('/', url()).href, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.catalog-panel')
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent === 'Manage roots')
          ?.click(),
      )
      await page.type('[aria-label="Root folder"]', repoPath)
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent === 'Add root')
          ?.click(),
      )
      await page.waitForFunction(
        (path: string) => document.querySelector('.catalog-root')?.textContent?.includes(path),
        {},
        repoPath,
      )
      await page.type('[aria-label="Root folder"]', temporary)
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent === 'Add root')
          ?.click(),
      )
      await page.waitForFunction(() => document.querySelectorAll('.catalog-root').length === 2)
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent === 'Back to repositories')
          ?.click(),
      )
      await page.waitForFunction(() =>
        document.querySelector('.catalog-footer')?.textContent?.includes('Scan complete'),
      )
      check(
        'home configures discovery roots without a review',
        (await page.$$('.catalog-repo')).length >= 2,
      )
      check(
        'discovery warnings have a compact collapsed summary',
        await page.$eval(
          '.catalog-scan-errors',
          (element) =>
            !element.hasAttribute('open') &&
            element.querySelector('summary')?.textContent?.includes('2 discovery warnings') ===
              true,
        ),
      )
      await page.click('.catalog-scan-errors summary')
      check(
        'expanded warnings explain missing metadata without dumping Git commands',
        await page.$eval(
          '.catalog-scan-error-list',
          (element) =>
            element.textContent?.includes('missing Git directory') === true &&
            !element.textContent.includes('Command failed') &&
            element.querySelectorAll('.catalog-scan-error').length === 2,
        ),
      )
      await page.click('.catalog-scan-errors summary')
      // Opening an excluded module explicitly used to make it survive every rescan.
      await page.evaluate(
        async (path: string) => {
          const response = await fetch('/api/repos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ repoPath: path }),
          })
          if (!response.ok) throw new Error('Could not register stale module fixture')
        },
        join(terraform, 'modules', 'eks.eks.kms'),
      )
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Clear & rescan')
          ?.click(),
      )
      await page.waitForFunction(async () => {
        const catalog = await (await fetch('/api/catalog')).json()
        return (
          !catalog.scan.active &&
          !catalog.repositories.some((repo: { commonDir: string }) =>
            repo.commonDir.includes('/.terraform/'),
          )
        )
      })
      await page.waitForFunction(() =>
        document.querySelector('.catalog-footer')?.textContent?.includes('Scan complete'),
      )
      await page.type('.catalog-search', 'eks.eks.kms')
      check(
        'Terraform dependency is absent from search',
        (await page.$$('.catalog-repo')).length === 0,
      )
      await page.$eval('.catalog-search', (element) => (element as HTMLInputElement).select())
      await page.keyboard.press('Backspace')
      const statusRequests: string[][] = []
      page.on('request', (request) => {
        if (request.url().endsWith('/api/catalog/status'))
          statusRequests.push(JSON.parse(request.postData() ?? '{}').ids)
      })
      await page.type('.catalog-search', 'another repo')
      await page.waitForFunction(() => document.querySelectorAll('.catalog-repo').length === 1)
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.keyboard.press('Enter'),
      ])
      check(
        'discovery opens a repository never registered by the CLI',
        page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      statusRequests.length = 0
      await load('?target=feature&base=main&committed=1')
      const listedStatus = page.waitForResponse((response) =>
        response.url().endsWith('/api/catalog/status'),
      )
      await page.keyboard.press('o')
      await page.waitForSelector('.catalog-search')
      const listed = (await (await listedStatus).json()) as { statuses: { id: string }[] }
      check(
        'only main checkouts request Git status',
        listed.statuses.some((status) => status.id === repoIdFor(repoPath)) &&
          !listed.statuses.some((status) => status.id === repoIdFor(linked)),
      )
      check(
        'picker has one destination per repository and no worktree list',
        await page.evaluate(
          () =>
            document.querySelectorAll('.catalog-repo').length === 2 &&
            document.querySelectorAll('.catalog-worktree').length === 0 &&
            !document.querySelector('.catalog-repos')?.textContent?.includes('catalog-linked'),
        ),
      )
      await page.type('.catalog-search', 'catalog-linked')
      check(
        'worktree branches are not picker destinations',
        (await page.$$('.catalog-repo')).length === 0,
      )
      await page.$eval('.catalog-search', (element) => (element as HTMLInputElement).select())
      await page.keyboard.press('Backspace')
      check(
        'keyboard shortcut focuses repository search',
        await page.evaluate(() => document.activeElement?.className === 'catalog-search'),
      )
      const reviewBeforeFavorite = page.url()
      await page.click('[aria-label="Add another repo to favorites"]')
      await page.waitForSelector(
        '[aria-label="Remove another repo from favorites"][aria-pressed="true"]',
      )
      check(
        'favoriting keeps the review open and moves the repo first',
        page.url() === reviewBeforeFavorite &&
          (await page.$eval(
            '.catalog-repo',
            (element) => element.textContent?.includes('another repo') === true,
          )),
      )
      await page.reload({ waitUntil: 'networkidle0' })
      await page.keyboard.press('o')
      await page.waitForSelector(
        '[aria-label="Remove another repo from favorites"][aria-pressed="true"]',
      )
      check(
        'favorite order survives reload',
        await page.$eval(
          '.catalog-repo',
          (element) => element.textContent?.includes('another repo') === true,
        ),
      )
      for (const theme of ['github-dimmed', 'github-dark', 'catppuccin-frappe']) {
        await page.evaluate((value: string) => {
          document.documentElement.dataset.theme = value
        }, theme)
        await page.screenshot({ path: join(tmpdir(), `ghl-catalog-${theme}.png`) })
      }
      await page.focus('[aria-label="Remove another repo from favorites"]')
      await page.keyboard.press('Enter')
      await page.waitForSelector(
        '[aria-label="Add another repo to favorites"][aria-pressed="false"]',
      )
      check('keyboard removes a favorite without navigating', page.url() === reviewBeforeFavorite)
      await page.keyboard.press('Escape')
      check(
        'escape returns focus to repository trigger',
        await page.evaluate(
          () => document.activeElement?.classList.contains('catalog-trigger') === true,
        ),
      )
      await clickTreeRow(page, 'src/core/cache.ts')
      await sleep(500)
      // Use an actual visible gutter to start a draft on the file being read.
      const point = await page.evaluate(() => {
        for (const host of document.querySelectorAll('.diff diffs-container')) {
          const cell = host.shadowRoot?.querySelector('[data-gutter]')
          const box = cell?.getBoundingClientRect()
          if (box && box.width) {
            const top = Math.max(
              box.top,
              document.querySelector('.diff')!.getBoundingClientRect().top + 70,
            )
            const bottom = Math.min(box.bottom, innerHeight - 50)
            if (bottom > top + 20) return { x: box.x + box.width / 2, y: (top + bottom) / 2 }
          }
        }
        return null
      })
      if (!point) throw new Error('No visible gutter')
      await page.mouse.move(point.x, point.y)
      await sleep(250)
      const plus = await page.evaluate(() => {
        for (const host of document.querySelectorAll('.diff diffs-container')) {
          const box = host.shadowRoot
            ?.querySelector('[data-utility-button]')
            ?.getBoundingClientRect()
          if (box?.width) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        }
        return null
      })
      if (!plus) throw new Error('No gutter button')
      await page.mouse.click(plus.x, plus.y)
      await page.waitForSelector('.comment-composer textarea')
      await page.type('.comment-composer textarea', 'Keep this navigation draft')
      const before = (await page.evaluate(DIFF_ON_SCREEN)) as string[]
      await page.click('.catalog-trigger')
      await page.waitForSelector('.catalog-search')
      await page.type('.catalog-search', 'another repo')
      await page.waitForFunction(() => document.querySelectorAll('.catalog-repo').length === 1)
      check(
        'search finds a repository and displays its main checkout path',
        await page.evaluate(
          (path: string) =>
            document.querySelector('.catalog-repo')?.textContent?.includes(path) === true,
          undiscovered,
        ),
      )
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.keyboard.press('Enter'),
      ])
      check(
        'first repository visit has no inherited comparison parameters',
        new URL(page.url()).search === '' &&
          page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      check(
        'draft does not leak to another repository',
        (await page.$$('.comment-composer')).length === 0,
      )
      await page.click('.catalog-trigger')
      await page.waitForSelector('.catalog-search')
      await page.type('.catalog-search', repoPath.split('/').at(-1)!)
      await page.waitForFunction(() => document.querySelectorAll('.catalog-repo').length === 1)
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.keyboard.press('Enter'),
      ])
      await page.waitForSelector('.comment-composer textarea')
      check(
        'A → B → A restores comparison',
        new URL(page.url()).search === '?target=feature&base=main&committed=1',
      )
      check(
        'A → B → A restores the draft',
        (await page.$eval(
          '.comment-composer textarea',
          (element) => (element as HTMLTextAreaElement).value,
        )) === 'Keep this navigation draft',
      )
      await sleep(800)
      const after = (await page.evaluate(DIFF_ON_SCREEN)) as string[]
      check(
        'reading resumes at the previous file',
        before.some((path) => after.includes(path)),
        `${before} → ${after}`,
      )
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('.comment-composer textarea')
      check(
        'draft survives reload',
        (await page.$eval(
          '.comment-composer textarea',
          (element) => (element as HTMLTextAreaElement).value,
        )) === 'Keep this navigation draft',
      )
      const seeded = await page.evaluate(async () => {
        const endpoint = location.pathname + '/api/comments' + location.search
        return (
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'catalog-panel',
              path: 'src/core/cache.ts',
              side: 'additions',
              start: 1,
              end: 1,
              body: 'Saved panel comment',
              range: 'main..feature',
            }),
          })
        ).ok
      })
      check('panel draft fixture saved', seeded)
      await page.reload({ waitUntil: 'networkidle0' })
      await page.click('.comments-trigger')
      await page.click('.comments-panel [data-comment-id="catalog-panel"] .comment-menu summary')
      await page.click(
        '.comments-panel [data-comment-id="catalog-panel"] .comment-menu-items button',
      )
      await page.$eval('.panel-editor textarea', (element) =>
        (element as HTMLTextAreaElement).select(),
      )
      await page.type('.panel-editor textarea', 'Keep this panel draft')
      await page.reload({ waitUntil: 'networkidle0' })
      await page.click('.comments-trigger')
      await page.waitForSelector('.panel-editor textarea')
      check(
        'Comments panel edit survives reload',
        (await page.$eval(
          '.panel-editor textarea',
          (element) => (element as HTMLTextAreaElement).value,
        )) === 'Keep this panel draft',
      )
      await page.click('[aria-label="Close comments"]')
      await page.goBack({ waitUntil: 'networkidle0' })
      check(
        'browser back returns to the other repository without leaked parameters',
        page.url().includes(encodeURIComponent(repoIdFor(undiscovered))) &&
          new URL(page.url()).search === '',
      )
      await page.goForward({ waitUntil: 'networkidle0' })
      await page.click('.comments-trigger')
      await page.waitForSelector('.panel-editor textarea')
      check(
        'browser forward restores panel draft',
        (await page.$eval(
          '.panel-editor textarea',
          (element) => (element as HTMLTextAreaElement).value,
        )) === 'Keep this panel draft',
      )
      await page.click('[aria-label="Close comments"]')
      // Retry an edit from the diff while keeping the other unsaved composer in session.
      await page.click('.comments-trigger')
      await page.click('.panel-editor button[type="button"]')
      await page.click(
        '.comments-panel [data-comment-id="catalog-panel"] .comment-navigation button',
      )
      await page.waitForSelector('.diff [data-comment-id="catalog-panel"]')
      await page.evaluate(() =>
        document
          .querySelector<HTMLButtonElement>(
            '.diff [data-comment-id="catalog-panel"] .comment-menu-items button',
          )
          ?.click(),
      )
      await page.waitForSelector('.comment-composer textarea')
      await page.$eval('.comment-composer textarea', (element) =>
        (element as HTMLTextAreaElement).select(),
      )
      await page.type('.comment-composer textarea', 'Retried comment edit')
      await page.evaluate(() => {
        const original = window.fetch
        window.fetch = (input, options) => {
          if (String(input).includes('/api/comments') && options?.method === 'PATCH') {
            window.fetch = original
            return Promise.resolve(new Response('{}', { status: 503 }))
          }
          return original(input, options)
        }
      })
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.comment-composer button')]
          .find((button) => button.textContent === 'Update')
          ?.click(),
      )
      await page.waitForSelector('.diff [data-comment-id="catalog-panel"] .comment-state.failed')
      await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            '.diff [data-comment-id="catalog-panel"] button',
          ),
        ]
          .find((button) => button.textContent === 'Retry')
          ?.click(),
      )
      await page.waitForSelector('.diff [data-comment-id="catalog-panel"] .comment-state', {
        hidden: true,
      })
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('.comment-composer textarea')
      check(
        'a successful comment retry retires its draft while preserving the other composer',
        (await page.$eval(
          '.comment-composer textarea',
          (element) => (element as HTMLTextAreaElement).value,
        )) === 'Keep this navigation draft',
      )
      // Failed session storage must leave the review and its text in place.
      await page.evaluate(() => {
        const original = Storage.prototype.setItem
        window.addEventListener(
          'ghl-test-restore-storage',
          () => {
            Storage.prototype.setItem = original
          },
          { once: true },
        )
        Storage.prototype.setItem = () => {
          throw new Error('Storage disabled')
        }
      })
      await page.click('.catalog-trigger')
      await page.type('.catalog-search', 'another repo')
      await page.waitForFunction(() => document.querySelectorAll('.catalog-repo').length === 1)
      await page.click('.catalog-repo')
      await page.waitForSelector('.catalog-panel [role="alert"]')
      check(
        'storage failure blocks switching repositories',
        !page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      await page.evaluate(() => window.dispatchEvent(new Event('ghl-test-restore-storage')))
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('.viewed-toggle input')
      await page.evaluate(() => {
        const original = window.fetch
        window.addEventListener(
          'ghl-restore-fetch',
          () => {
            window.fetch = original
          },
          { once: true },
        )
        window.fetch = (input, options) => {
          if (String(input).endsWith('/api/viewed') && options?.method === 'POST')
            return new Promise((resolve) => {
              window.addEventListener(
                'ghl-release-save',
                () => resolve(new Response('{}', { status: 503 })),
                { once: true },
              )
            })
          return original(input, options)
        }
        document.querySelector<HTMLInputElement>('.viewed-toggle input')?.click()
      })
      await page.click('.catalog-trigger')
      await page.type('.catalog-search', 'another repo')
      await page.waitForFunction(() => document.querySelectorAll('.catalog-repo').length === 1)
      await page.click('.catalog-repo')
      await sleep(200)
      check(
        'navigation waits for a pending Viewed write',
        !page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      await page.evaluate(() => window.dispatchEvent(new Event('ghl-release-save')))
      await page.waitForSelector('.catalog-panel [role="alert"]')
      check(
        'a failed review write keeps the current checkout',
        !page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      await page.evaluate(() => window.dispatchEvent(new Event('ghl-restore-fetch')))
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('.catalog-panel [role="alert"] button'),
      ])
      check(
        'retry saves the failed write before switching',
        page.url().includes(encodeURIComponent(repoIdFor(undiscovered))),
      )
      await page.goBack({ waitUntil: 'networkidle0' })
      await page.goto(url('?target=feature&base=main'), { waitUntil: 'networkidle0' })
      check(
        'explicit URL overrides remembered comparison',
        new URL(page.url()).search === '?target=feature&base=main' &&
          (await page.$$('.comment-composer')).length === 0,
      )
      // Modify the file in the remembered comparison; its draft must become recoverable text.
      const draftPath = await page.evaluate(() => {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i)!
          if (!key.includes(':drafts:') || !key.includes('committed')) continue
          const drafts = JSON.parse(sessionStorage.getItem(key)!).drafts
          return (Object.values(drafts)[0] as { composer: { path: string } })?.composer.path
        }
        return undefined
      })
      if (!draftPath) throw new Error('Saved draft missing')
      // The fixture reviews feature, so update that branch through an isolated linked checkout.
      git('worktree', 'add', '-q', join(temporary, 'feature-edit'), 'feature')
      writeFileSync(join(temporary, 'feature-edit', draftPath), 'changed during review\n')
      execFileSync('git', ['-C', join(temporary, 'feature-edit'), 'add', draftPath])
      execFileSync('git', [
        '-C',
        join(temporary, 'feature-edit'),
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'change draft context',
      ])
      await page.goto(url('?target=feature&base=main&committed=1'), { waitUntil: 'networkidle0' })
      await page.waitForSelector('.recovered-drafts textarea')
      check(
        'changed code recovers text without attaching it to new lines',
        (await page.$$('.comment-composer')).length === 0 &&
          (await page.$eval(
            '.recovered-drafts textarea',
            (element) => (element as HTMLTextAreaElement).value,
          )) === 'Keep this navigation draft',
      )
      await page.setViewport({ width: 390, height: 844 })
      await page.click('.catalog-trigger')
      await page.waitForSelector('.catalog-panel')
      check(
        'mobile picker fills the viewport',
        await page.$eval(
          '.catalog-panel',
          (element) => Math.round(element.getBoundingClientRect().width) === 390,
        ),
      )
      await page.screenshot({ path: join(tmpdir(), 'ghl-catalog-mobile.png') })
      check(
        'status requests are bounded and only known destinations',
        statusRequests.every(
          (ids) =>
            ids.length <= 100 &&
            ids.every((id) => [repoIdFor(repoPath), repoIdFor(undiscovered)].includes(id)),
        ),
      )
    } finally {
      git('worktree', 'remove', '--force', linked)
      try {
        git('worktree', 'remove', '--force', join(temporary, 'feature-edit'))
      } catch {
        /* not created if an earlier assertion threw */
      }
      git('branch', '-D', 'catalog-linked')
      rmSync(undiscovered, { recursive: true, force: true })
      rmSync(stale, { recursive: true, force: true })
      rmSync(terraform, { recursive: true, force: true })
      rmSync(temporary, { recursive: true, force: true })
    }
  },
} satisfies Suite
