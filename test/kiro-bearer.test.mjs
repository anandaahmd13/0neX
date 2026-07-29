import assert from 'node:assert/strict'
import test from 'node:test'
import { createKiroBearerValidator, kiroProfileHost } from '../server/gateway/kiro-bearer.mjs'

const SECRET = 'ksk_live_bearer_secret_value'
const PROFILE_TARGET = 'AmazonCodeWhispererService.ListAvailableProfiles'
const MODEL_TARGET = 'AmazonCodeWhispererService.ListAvailableModels'

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

function stubFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { impl, calls }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function discoveryFetch({ profiles = [], models = [{ modelId: 'auto' }] } = {}) {
  return stubFetch((_url, init) => {
    const target = init.headers['x-amz-target']
    if (target === PROFILE_TARGET) return jsonResponse({ profiles })
    if (target === MODEL_TARGET) return jsonResponse({ models })
    throw new Error(`Unexpected target: ${target}`)
  })
}

test('region selects the host and discovery sends the selected profile ARN', async () => {
  assert.equal(kiroProfileHost('us-east-1'), 'https://codewhisperer.us-east-1.amazonaws.com')
  assert.equal(kiroProfileHost('eu-central-1'), 'https://codewhisperer.eu-central-1.amazonaws.com')

  const selectedArn = 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/BBBB'
  const { impl, calls } = discoveryFetch({
    profiles: [
      { arn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA' },
      { arn: selectedArn },
    ],
    models: [
      { modelId: 'auto' },
      { id: 'claude-sonnet-5' },
      { modelId: 'claude-sonnet-5' },
      { modelId: 'invalid/model' },
      { modelId: ' bad' },
    ],
  })

  const validator = createKiroBearerValidator({ fetchImpl: impl, assertHost: async () => {} })
  const result = await validator.validateApiKey({ apiKey: SECRET, region: 'eu-central-1' })

  assert.equal(result.region, 'eu-central-1')
  assert.equal(result.profileArn, selectedArn)
  assert.deepEqual(result.models, ['auto', 'claude-sonnet-5', 'invalid/model'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://codewhisperer.eu-central-1.amazonaws.com')
  assert.equal(calls[0].init.headers['x-amz-target'], PROFILE_TARGET)
  assert.equal(calls[1].init.headers['x-amz-target'], MODEL_TARGET)
  assert.equal(calls[1].init.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(calls[1].init.headers.tokentype, 'API_KEY')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    origin: 'AI_EDITOR',
    profileArn: selectedArn,
  })
  assert.equal(typeof result.validatedAt, 'string')
})

test('email comes from bearer claims and model discovery omits a missing profile ARN', async () => {
  const key = jwt({ email: 'owner@example.com', sub: 'user-1' })
  const first = discoveryFetch({
    profiles: [{ profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X' }],
  })
  const validator = createKiroBearerValidator({ fetchImpl: first.impl, assertHost: async () => {} })

  const result = await validator.validateApiKey({ apiKey: key })
  assert.equal(result.email, 'owner@example.com')
  assert.equal(result.region, 'us-east-1')

  const opaqueFetch = discoveryFetch({ profiles: [], models: [{ modelId: 'auto' }] })
  const opaque = await createKiroBearerValidator({
    fetchImpl: opaqueFetch.impl,
    assertHost: async () => {},
  }).validateApiKey({ apiKey: 'not-a-jwt' })
  assert.equal(opaque.email, null)
  assert.equal(opaque.profileArn, null)
  assert.deepEqual(JSON.parse(opaqueFetch.calls[1].init.body), { origin: 'AI_EDITOR' })
})

test('rejected bearer credentials fail without leaking the secret', async () => {
  const { impl } = stubFetch(() => ({
    ok: false,
    status: 403,
    json: async () => ({}),
    text: async () => `AccessDeniedException: token ${SECRET} is not authorized`,
  }))
  const validator = createKiroBearerValidator({ fetchImpl: impl, assertHost: async () => {} })

  await assert.rejects(
    () => validator.validateApiKey({ apiKey: SECRET, region: 'us-east-1' }),
    (error) => {
      assert.equal(error.code, 'KIRO_BEARER_REJECTED')
      assert.ok(!error.message.includes(SECRET), `secret leaked: ${error.message}`)
      return true
    },
  )
})

test('empty model catalogs are preserved while malformed discovery responses fail', async () => {
  const empty = discoveryFetch({ profiles: [], models: [] })
  const withoutModels = await createKiroBearerValidator({
    fetchImpl: empty.impl,
    assertHost: async () => {},
  }).validateApiKey({ apiKey: SECRET })
  assert.deepEqual(withoutModels.models, [])

  const malformed = stubFetch((_url, init) => jsonResponse(
    init.headers['x-amz-target'] === PROFILE_TARGET ? { profiles: [] } : { unexpected: [] },
  ))
  await assert.rejects(
    () => createKiroBearerValidator({
      fetchImpl: malformed.impl,
      assertHost: async () => {},
    }).validateApiKey({ apiKey: SECRET }),
    (error) => error.code === 'KIRO_BEARER_INVALID_RESPONSE',
  )
})

test('bad regions and blank keys are refused before network access', async () => {
  const unused = discoveryFetch()
  const validator = createKiroBearerValidator({ fetchImpl: unused.impl, assertHost: async () => {} })
  await assert.rejects(() => validator.validateApiKey({ apiKey: '   ' }), /wajib diisi/i)
  await assert.rejects(() => validator.validateApiKey({ apiKey: SECRET, region: 'mars-1' }), /region/i)
  assert.equal(unused.calls.length, 0)
})

test('the CodeWhisperer host passes through the SSRF guard before each request', async () => {
  const seen = []
  const { impl, calls } = discoveryFetch()
  const validator = createKiroBearerValidator({
    fetchImpl: impl,
    assertHost: async (hostname) => {
      seen.push(hostname)
      throw new Error(`blocked ${hostname}`)
    },
  })

  await assert.rejects(() => validator.validateApiKey({ apiKey: SECRET }), /blocked/)
  assert.deepEqual(seen, ['codewhisperer.us-east-1.amazonaws.com'])
  assert.equal(calls.length, 0)
})
