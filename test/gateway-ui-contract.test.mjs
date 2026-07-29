import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourcePath = new URL('../src/pages/Gateway.tsx', import.meta.url)
const apiPath = new URL('../src/lib/gatewayApi.ts', import.meta.url)

test('Connect Kiro modal exposes accessible regional bearer fields and safe responsive layout', async () => {
  const [source, api] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(apiPath, 'utf8'),
  ])

  assert.match(api, /export type KiroRegion = 'us-east-1' \| 'eu-central-1'/)
  assert.match(api, /region\?: KiroRegion/)

  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby="kiro-modal-title"/)
  assert.match(source, /max-h-\[calc\(100vh-2rem\)\]/)
  assert.match(source, /w-full max-w-/)
  assert.match(source, /overflow-y-auto/)

  assert.match(source, /id="kiro-api-key"/)
  assert.match(source, /htmlFor="kiro-api-key"/)
  assert.match(source, /type="password"/)
  assert.match(source, /placeholder="Paste your Kiro API key\.\.\."/)
  assert.match(source, /id="kiro-region"/)
  assert.match(source, /htmlFor="kiro-region"/)
  assert.match(source, /<option value="us-east-1">us-east-1<\/option>/)
  assert.match(source, /<option value="eu-central-1">eu-central-1<\/option>/)

  assert.match(source, /Paste a long-lived Kiro\/CodeWhisperer API key\. It is validated against AWS and stored directly as a bearer credential \(no refresh\)\./)
  assert.match(source, /Generate an API key from Kiro Portal → API Keys\. API-key authentication requires an eligible paid plan\./)
  assert.match(source, /href="https:\/\/app\.kiro\.dev"/)
  assert.match(source, /target="_blank"/)
  assert.match(source, /rel="noreferrer"/)

  assert.match(source, /Add API Key/)
  assert.match(source, /Validating against AWS\.\.\./)
  assert.match(source, /Validate & update/)
  assert.match(source, /AWS validated · bearer credential stored/)
})
