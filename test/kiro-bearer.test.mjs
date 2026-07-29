import assert from 'node:assert/strict'
import test from 'node:test'
import { createKiroBearerValidator, kiroProfileHost } from '../server/gateway/kiro-bearer.mjs'

const SECRET = 'ksk_live_bearer_secret_value'

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

test('region selects the CodeWhisperer host and the profile ARN of that region', async () => {
  assert.equal(kiroProfileHost('us-east-1'), 'https://codewhisperer.us-east-1.amazonaws.com')
  assert.equal(kiroProfileHost('eu-central-1'), 'https://codewhisperer.eu-central-1.amazonaws.com')

  const { impl, calls } = stubFetch(() => jsonResponse({
    profiles: [
      { arn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA' },
      { arn: 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/BBBB' },
    ],
  }))

  const validator = createKiroBearerValidator({ fetchImpl: impl, assertHost: async () => {} })
  const result = await validator.validateApiKey({ apiKey: SECRET, region: 'eu-central-1' })

  assert.equal(result.region, 'eu-central-1')
  assert.equal(result.profileArn, 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/BBBB')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://codewhisperer.eu-central-1.amazonaws.com')
  assert.equal(
    calls[0].init.headers['x-amz-target'],
    'AmazonCodeWhispererService.ListAvailableProfiles',
  )
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(typeof result.validatedAt, 'string')
})

test('email comes from the bearer JWT claims and never from the caller', async () => {
  const key = jwt({ email: 'owner@example.com', sub: 'user-1' })
  const { impl } = stubFetch(() => jsonResponse({
    profiles: [{ profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X' }],
  }))
  const validator = createKiroBearerValidator({ fetchImpl: impl, assertHost: async () => {} })

  const result = await validator.validateApiKey({ apiKey: key })
  assert.equal(result.email, 'owner@example.com')
  assert.equal(result.region, 'us-east-1')

  const opaque = await createKiroBearerValidator({
    fetchImpl: stubFetch(() => jsonResponse({ profiles: [{ arn: 'arn:aws:cw:us-east-1:1:profile/Y' }] })).impl,
    assertHost: async () => {},
  }).validateApiKey({ apiKey: 'not-a-jwt' })
  assert.equal(opaque.email, null)
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

test('empty profile lists use the token default; bad regions and blank keys are refused', async () => {
  const emptyProfiles = stubFetch(() => jsonResponse({ profiles: [] }))
  const withoutProfile = await createKiroBearerValidator({
    fetchImpl: emptyProfiles.impl,
    assertHost: async () => {},
  }).validateApiKey({ apiKey: SECRET })
  assert.equal(withoutProfile.profileArn, null)
  assert.equal(withoutProfile.region, 'us-east-1')
  assert.equal(emptyProfiles.calls.length, 1)

  const unused = stubFetch(() => jsonResponse({ profiles: [] }))
  const validator = createKiroBearerValidator({ fetchImpl: unused.impl, assertHost: async () => {} })
  await assert.rejects(() => validator.validateApiKey({ apiKey: '   ' }), /wajib diisi/i)
  await assert.rejects(() => validator.validateApiKey({ apiKey: SECRET, region: 'mars-1' }), /region/i)
  assert.equal(unused.calls.length, 0)
})

test('the CodeWhisperer host passes through the SSRF guard before the request', async () => {
  const seen = []
  const { impl, calls } = stubFetch(() => jsonResponse({
    profiles: [{ arn: 'arn:aws:cw:us-east-1:1:profile/Z' }],
  }))
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
