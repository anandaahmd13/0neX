#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { appendFileSync, closeSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env.KIRO_FIXTURE_MODE ?? 'normal'
const recordFile = process.env.KIRO_FIXTURE_RECORD

function record(type, data = {}) {
  if (!recordFile) return
  appendFileSync(recordFile, `${JSON.stringify({ type, ...data })}\n`, { encoding: 'utf8', mode: 0o600 })
}

record('spawn', {
  pid: process.pid,
  args,
  home: process.env.HOME ?? null,
  userProfile: process.env.USERPROFILE ?? null,
  apiKeyPresent: Boolean(process.env.KIRO_API_KEY),
  apiKeyHash: process.env.KIRO_API_KEY
    ? createHash('sha256').update(process.env.KIRO_API_KEY).digest('hex')
    : null,
})

function hang() {
  setInterval(() => {}, 1_000)
}

if (mode === 'timeout' && args[0] !== 'acp') hang()
else if (args[0] === 'whoami') {
  if (mode === 'malformed-command') process.stdout.write('{not-json\n')
  else if (mode === 'command-fail') {
    process.stderr.write(`authentication failed for KIRO_API_KEY=${process.env.KIRO_API_KEY ?? 'missing'}\n`)
    process.exitCode = 7
  } else {
    process.stdout.write(`${JSON.stringify({
      authenticated: true,
      authMethod: process.env.KIRO_API_KEY ? 'api-key' : 'account-session',
      user: 'fixture-user',
    })}\n`)
  }
} else if (args[0] === 'chat' && args.includes('--list-models')) {
  if (mode === 'malformed-command') process.stdout.write('not-json\n')
  else if (mode === 'oversized-command' || mode === 'oversized-command-hang') {
    if (mode === 'oversized-command-hang') {
      process.on('SIGTERM', () => record('signal', { signal: 'SIGTERM' }))
    }
    process.stdout.write(JSON.stringify({ models: [{ id: 'x'.repeat(5_000) }] }))
    if (mode === 'oversized-command-hang') hang()
  } else {
    process.stdout.write(`${JSON.stringify({
      models: [
        { id: 'kiro-auto', name: 'Auto' },
        { modelId: 'claude-sonnet-4', displayName: 'Sonnet' },
        { name: 'display-only-not-an-id' },
      ],
      data: [{ model_id: 'kiro-fast' }, 'raw-model-id'],
      unrelated: { id: 'must-not-be-traversed' },
    })}\n`)
  }
} else if (args[0] === 'acp') {
  runAcp()
} else {
  process.stderr.write(`unsupported fixture args: ${JSON.stringify(args)}\n`)
  process.exitCode = 2
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendFragmented(message) {
  const line = `${JSON.stringify(message)}\n`
  const split = Math.max(1, Math.floor(line.length / 2))
  process.stdout.write(line.slice(0, split))
  setTimeout(() => process.stdout.write(line.slice(split)), 5)
}

function sendTogether(messages) {
  process.stdout.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function notification(sessionId, update) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  }
}

function runAcp() {
  let buffer = ''
  let promptRequest = null
  let activeSessionId = null

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        process.exit(3)
      }
      record('rpc', { message })
      handle(message)
    }
  })

  function finishPrompt(stopReason = 'end_turn') {
    if (!promptRequest) return
    send(response(promptRequest.id, { stopReason }))
    promptRequest = null
  }

  function handle(message) {
    if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      if (message.id === 900 && promptRequest) {
        record('permission-response', { message })
        sendTogether([
          notification(activeSessionId, {
            sessionUpdate: 'AgentMessageChunk',
            content: { type: 'text', text: 'permission denied safely' },
          }),
          notification(activeSessionId, { sessionUpdate: 'TurnEnd', stopReason: 'end_turn' }),
          response(promptRequest.id, { stopReason: 'end_turn' }),
        ])
        promptRequest = null
      }
      return
    }

    if (message.method === 'initialize') {
      if (mode === 'malformed-acp') {
        process.stdout.write('{broken-json\n')
        return
      }
      if (mode === 'acp-timeout') return
      const initialized = response(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: 'kiro-fixture', version: '1.0.0' },
      })
      if (mode === 'broken-stdin') {
        send(initialized)
        closeSync(0)
        hang()
        return
      }
      sendFragmented(initialized)
      return
    }

    if (message.method === 'session/new') {
      activeSessionId = 'fixture-new-session'
      send(response(message.id, { sessionId: activeSessionId }))
      return
    }

    if (message.method === 'session/load') {
      activeSessionId = message.params.sessionId
      if (mode === 'load-replay') {
        send(notification(activeSessionId, {
          sessionUpdate: 'AgentMessageChunk',
          content: { type: 'text', text: 'old replayed output' },
        }))
      }
      send(response(message.id, null))
      return
    }

    if (message.method === 'session/set_model') {
      send(response(message.id, null))
      return
    }

    if (message.method === 'session/prompt') {
      promptRequest = message
      if (mode === 'prompt-timeout') return
      if (mode === 'cancel') {
        send(notification(activeSessionId, {
          sessionUpdate: 'AgentMessageChunk',
          content: { type: 'text', text: 'waiting for cancel' },
        }))
        return
      }
      if (mode === 'permission') {
        sendTogether([
          notification(activeSessionId, {
            sessionUpdate: 'ToolCall',
            toolCallId: 'tool-1',
            title: 'Dangerous tool',
            status: 'pending',
          }),
          {
            jsonrpc: '2.0',
            id: 900,
            method: 'session/request_permission',
            params: {
              sessionId: activeSessionId,
              toolCall: { toolCallId: 'tool-1' },
              options: [
                { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
                { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
              ],
            },
          },
        ])
        return
      }
      if (mode === 'active-tool') {
        send(notification(activeSessionId, {
          sessionUpdate: 'ToolCallUpdate',
          toolCallId: 'tool-2',
          status: 'in_progress',
        }))
        return
      }

      const first = notification(activeSessionId, {
        sessionUpdate: 'AgentMessageChunk',
        content: { type: 'text', text: 'hello ' },
      })
      const second = notification(activeSessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'from fixture' },
      })
      sendTogether([first, second])
      const end = notification(activeSessionId, {
        sessionUpdate: 'TurnEnd',
        stopReason: 'end_turn',
      })
      if (mode === 'turnend-only') {
        sendFragmented(end)
        return
      }
      const promptResponse = response(message.id, { stopReason: 'end_turn' })
      const joined = `${JSON.stringify(end)}\n${JSON.stringify(promptResponse)}\n`
      const split = Math.floor(joined.length / 3)
      process.stdout.write(joined.slice(0, split))
      setTimeout(() => process.stdout.write(joined.slice(split)), 5)
      promptRequest = null
      return
    }

    if (message.method === 'session/cancel') {
      record('cancel', { sessionId: message.params?.sessionId })
      finishPrompt('cancelled')
      return
    }

    if (Object.hasOwn(message, 'id')) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `unsupported: ${message.method}` },
      })
    }
  }
}
