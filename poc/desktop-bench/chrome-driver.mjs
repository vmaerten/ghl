// Controls only a fresh Chrome for Testing profile owned by this benchmark.
import puppeteer from 'puppeteer-core'
import { createInterface } from 'node:readline'

const browser = await puppeteer.launch({
  executablePath: process.argv[2],
  userDataDir: process.argv[3],
  headless: false,
  pipe: true,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--window-size=1280,820', '--no-first-run', '--no-default-browser-check'],
})
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
send({
  pid: browser.process().pid,
  version: await browser.version(),
  args: browser.process().spawnargs,
})
let review
try {
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const command = JSON.parse(line)
      if (command.action === 'close') {
        await browser.close()
        send({ closed: true })
        break
      }
      if (command.action === 'new') review = await browser.newPage()
      else if (command.action !== 'reuse' || !review)
        throw new Error('Unknown command or missing tab')
      await review.bringToFront()
      await review.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      send({ pages: (await browser.pages()).length })
    } catch (error) {
      send({ error: String(error) })
    }
  }
} finally {
  if (browser.connected) await browser.close()
}
