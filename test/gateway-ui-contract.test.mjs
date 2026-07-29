import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourcePath = new URL('../src/pages/Gateway.tsx', import.meta.url)
const apiPath = new URL('../src/lib/gatewayApi.ts', import.meta.url)
const playgroundPath = new URL('../src/pages/Playground.tsx', import.meta.url)
const panesPath = new URL('../src/lib/usePanes.ts', import.meta.url)

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

  // Jalur import bearer: connection Kiro baru lewat /admin/connections/kiro/api-key,
  // bukan createConnection generik.
  assert.match(api, /export interface KiroApiKeyImport/)
  assert.match(api, /profileArn\?: string/)
  assert.match(api, /email\?: string/)
  assert.match(api, /importKiroApiKey/)
  assert.match(api, /'\/admin\/connections\/kiro\/api-key'/)
  assert.match(source, /gatewayApi\.importKiroApiKey\(/)

  // Identitas hasil validasi ditampilkan, dan ARN panjang tidak boleh merusak layout.
  assert.match(source, /CodeWhisperer profile/)
  assert.match(source, /connection\.profileArn/)
  assert.match(source, /break-all/)
})

test('Kiro model discovery controls and Playground selection use active connection models', async () => {
  const [gateway, api, playground, panes] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(apiPath, 'utf8'),
    readFile(playgroundPath, 'utf8'),
    readFile(panesPath, 'utf8'),
  ])

  assert.match(api, /availableModels\?: string\[\]/)
  assert.match(api, /activeModels\?: string\[\]/)
  assert.match(api, /testKiroModel/)
  assert.match(api, /models\/\$\{encodeURIComponent\(model\)\}\/test/)

  assert.match(gateway, /Available Models/)
  assert.match(gateway, /\? 'Testing\.\.\.' : 'Test'/)
  assert.match(gateway, />\s*Copy\s*</)
  assert.match(gateway, /'× Delete'/)
  assert.match(gateway, /'Add'/)
  assert.match(gateway, /navigator\.clipboard\.writeText/)
  assert.match(gateway, /gatewayApi\.updateConnection\(connection\.id, \{ models \}\)/)
  assert.doesNotMatch(gateway, /models: \['auto'\]/)

  assert.match(panes, /modelId: string/)
  assert.match(panes, /modelId: typeof pane\.modelId === 'string' \? pane\.modelId : ''/)
  assert.match(panes, /const setModel = useCallback/)
  assert.match(panes, /connectionId,\n\s+modelId: ''/)

  assert.match(playground, /id=\{`kiro-model-\$\{pane\.id\}`\}/)
  assert.match(playground, /selectedConnection\?\.models/)
  assert.match(playground, /connection\.models\.includes\('auto'\) \? 'auto' : connection\.models\[0\]/)
  assert.match(playground, /model: agent\.providerId === 'kiro-cli' \? pane\.modelId : agent\.model/)
  assert.match(playground, /!availableModels\.includes\(pane\.modelId\)/)
})
