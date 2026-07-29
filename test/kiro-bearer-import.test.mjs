import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGatewayServer } from '../server/gateway-server.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const ORIGIN = 'http://localhost:5199'
const ADMIN = 'gateway-admin-test'

/** Validator palsu: merekam pemanggilan, tanpa jaringan dan tanpa CLI. */
function recordingValidator({ fail = null, profileArn = null, email = null } = {}) {
  const calls = []
  return {
    calls,
    validateApiKey: async ({ apiKey, region }) => {
      calls.push({ apiKey, region })
      if (fail) throw fail
      return {
        region: region ?? 'us-east-1',
        profileArn: profileArn ?? `arn:aws:codewhisperer:${region ?? 'us-east-1'}:1:profile/OK`,
        email,
        validatedAt: '2026-07-29T10:00:00.000Z',
      }
    },
  }
}

async function setup(t, validator) {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-kiro-import-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    wsToken: 'ws-token-test',
    apiKey: 'gateway-api-test',
    adminToken: ADMIN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
    kiroBearerValidator: validator,
    env: { ...process.env },
  })
  const address = await gateway.listen()
  t.after(() => gateway.close())
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir }
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

test('importing a Kiro API key validates over HTTPS and stores the connection', async (t) => {
  const validator = recordingValidator({
    profileArn: 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/BBBB',
    email: 'owner@example.com',
  })
  const { baseUrl, dataDir } = await setup(t, validator)
  const secret = 'ksk_import_secret_value'

  const { response, payload } = await post(baseUrl, '/admin/connections/kiro/api-key', {
    id: 'kiro-imported',
    name: 'Kiro Imported',
    apiKey: secret,
    region: 'eu-central-1',
  })

  assert.equal(response.status, 201, JSON.stringify(payload))
  assert.equal(payload.data.id, 'kiro-imported')
  assert.equal(payload.data.kind, 'kiro-cli')
  assert.equal(payload.data.credentialType, 'bearer')
  assert.equal(payload.data.region, 'eu-central-1')
  assert.equal(payload.data.hasApiKey, true)
  assert.equal(payload.data.profileArn, 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/BBBB')
  assert.equal(payload.data.email, 'owner@example.com')
  assert.equal(payload.data.validatedAt, '2026-07-29T10:00:00.000Z')
  assert.deepEqual(payload.data.models, ['auto'])

  // Key dikirim ke validator apa adanya, tapi tidak pernah dipantulkan balik.
  assert.deepEqual(validator.calls, [{ apiKey: secret, region: 'eu-central-1' }])
  assert.equal(JSON.stringify(payload).includes(secret), false)

  // Storage hanya menyimpan bentuk terenkripsi.
  const stored = await readFile(join(dataDir, 'connections.json'), 'utf8')
  assert.equal(stored.includes(secret), false)
  assert.ok(stored.includes('encryptedApiKey'))
})

test('import accepts an authenticated key without an explicit profile ARN', async (t) => {
  const validator = recordingValidator({ profileArn: null })
  validator.validateApiKey = async ({ apiKey, region }) => {
    validator.calls.push({ apiKey, region })
    return {
      region: region ?? 'us-east-1',
      profileArn: null,
      email: null,
      validatedAt: '2026-07-29T10:00:00.000Z',
    }
  }
  const { baseUrl } = await setup(t, validator)

  const { response, payload } = await post(baseUrl, '/admin/connections/kiro/api-key', {
    id: 'kiro-default-profile',
    apiKey: 'ksk_default_profile_probe',
  })

  assert.equal(response.status, 201, JSON.stringify(payload))
  assert.equal(payload.data.id, 'kiro-default-profile')
  assert.equal(payload.data.hasApiKey, true)
  assert.equal('profileArn' in payload.data, false)
})

test('import defaults to us-east-1 and derives an id when none is given', async (t) => {
  const validator = recordingValidator()
  const { baseUrl } = await setup(t, validator)

  const { response, payload } = await post(baseUrl, '/admin/connections/kiro/api-key', {
    apiKey: 'ksk_defaults_probe',
  })

  assert.equal(response.status, 201, JSON.stringify(payload))
  assert.equal(payload.data.region, 'us-east-1')
  assert.ok(payload.data.id.length > 0)
  assert.equal(validator.calls[0].region, undefined)
})

test('a rejected key writes nothing and never echoes the secret', async (t) => {
  const secret = 'ksk_rejected_secret_value'
  const failure = Object.assign(new Error(`AccessDenied for ${secret}`), {
    code: 'KIRO_BEARER_REJECTED',
    status: 401,
  })
  const validator = recordingValidator({ fail: failure })
  const { baseUrl, dataDir } = await setup(t, validator)

  const { response, payload } = await post(baseUrl, '/admin/connections/kiro/api-key', {
    id: 'kiro-rejected',
    apiKey: secret,
  })

  assert.equal(response.status, 401, JSON.stringify(payload))
  assert.equal(JSON.stringify(payload).includes(secret), false)

  const listed = await fetch(`${baseUrl}/admin/connections`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${ADMIN}` },
  }).then((r) => r.json())
  assert.deepEqual(listed.data, [])

  await assert.rejects(() => readFile(join(dataDir, 'connections.json'), 'utf8'), /ENOENT/)
})

test('import refuses a blank key before contacting CodeWhisperer', async (t) => {
  const validator = recordingValidator()
  const { baseUrl } = await setup(t, validator)

  const { response } = await post(baseUrl, '/admin/connections/kiro/api-key', {
    id: 'kiro-blank',
    apiKey: '   ',
  })

  assert.equal(response.status, 400)
  assert.equal(validator.calls.length, 0)
})

test('import requires admin auth', async (t) => {
  const validator = recordingValidator()
  const { baseUrl } = await setup(t, validator)

  const response = await fetch(`${baseUrl}/admin/connections/kiro/api-key`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'ksk_unauthorized' }),
  })

  assert.equal(response.status, 401)
  assert.equal(validator.calls.length, 0)
})
