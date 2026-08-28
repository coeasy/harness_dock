import { createServer } from 'node:http'
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('capability matrix lists web operations', async () => {
  const yaml = await readFile(
    path.join(repoRoot, 'packages/docs-sync/capability-matrix.yaml'),
    'utf8',
  )
  for (const id of [
    'configure-models',
    'choose-workspace',
    'run-task',
    'approval-flow',
    'session-export',
  ]) {
    expect(yaml).toContain(`id: ${id}`)
  }
})

test('mock workbench is reachable on loopback', async ({ page }) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><h1 data-testid="workbench">DeepSeek Harness</h1></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  await page.goto(`http://127.0.0.1:${address.port}`)
  await expect(page.getByTestId('workbench')).toHaveText('DeepSeek Harness')
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

test('live official SPA', async ({ page }) => {
  test.skip(!process.env.DSH_PARITY, 'set DSH_PARITY=1 to hit a real dsh web')
  const url = process.env.DSH_PARITY_URL ?? 'http://127.0.0.1:3080'
  await page.goto(url)
  await expect(page.locator('body')).toBeVisible()
})
