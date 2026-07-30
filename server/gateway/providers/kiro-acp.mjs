import { createAcpClientServices, createToolPolicyGuard } from '../acp-client-services.mjs'
import { createKiroRunner } from '../kiro-runner.mjs'

function publicProbeReason(status) {
  if (status?.code === 'KIRO_CLI_NOT_FOUND') {
    return 'Kiro CLI tidak ditemukan. Atur KIRO_CLI_COMMAND atau pasang Kiro CLI.'
  }
  if (status?.code === 'KIRO_ACP_VERSION') return 'Versi protokol ACP Kiro tidak didukung.'
  return status?.reason || 'Runtime Kiro ACP tidak tersedia.'
}

function completion(result) {
  const successful = !['cancelled', 'disposed', 'timeout', 'failed'].includes(result?.reason)
  return {
    code: successful ? 0 : null,
    reason: successful ? 'completed' : result?.reason ?? 'failed',
    sessionId: result?.sessionId ?? null,
    usage: null,
    ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
  }
}

function assertMcpTransportsSupported(servers, runtimeStatus) {
  const supported = new Set(runtimeStatus.supports?.mcpTransports ?? ['stdio'])
  for (const server of servers) {
    const transport = server?.type ?? 'stdio'
    if (!supported.has(transport)) {
      throw Object.assign(
        new Error(`Runtime Kiro ACP tidak mendukung MCP transport ${transport}.`),
        { code: 'KIRO_MCP_TRANSPORT_UNSUPPORTED' },
      )
    }
  }
}

export function createKiroAcpProvider({
  runner = createKiroRunner(),
  getConnection = async () => null,
  getWorkspace = async () => ({ id: 'default', root: process.cwd() }),
  getMcpServers = async () => [],
  cwd,
  probeAuth = { type: 'account-session' },
} = {}) {
  let runtimeStatus = {
    available: false,
    reason: 'Memeriksa runtime Kiro ACP…',
    supports: { acp: false, loadSession: false, mcpTransports: [] },
  }
  const ready = Promise.resolve()
    .then(() => runner.probe({ auth: probeAuth, cwd }))
    .then((status) => {
      runtimeStatus = status
      return status
    })
    .catch((error) => {
      runtimeStatus = {
        available: false,
        reason: error?.message || 'Runtime Kiro ACP tidak tersedia.',
        code: error?.code,
        supports: { acp: false, loadSession: false, mcpTransports: [] },
      }
      return runtimeStatus
    })

  async function authForRequest(request) {
    if (!request.connectionId) return { type: 'account-session' }
    const connection = await getConnection(request.connectionId)
    if (!connection || connection.kind !== 'kiro-cli' || !connection.enabled) {
      throw Object.assign(new Error('Pilih connection Kiro aktif untuk Kiro Agent.'), {
        code: 'KIRO_CONNECTION_REQUIRED',
      })
    }
    if (!connection.apiKey) {
      throw Object.assign(new Error('Connection Kiro tidak memiliki API key tersimpan.'), {
        code: 'KIRO_API_KEY_REQUIRED',
      })
    }
    return {
      type: 'api-key',
      secret: connection.apiKey,
      region: connection.region,
    }
  }

  return {
    id: 'kiro-agent',
    label: 'Kiro Agent (ACP)',
    ready,
    get capabilities() {
      return {
        streaming: true,
        sessions: runtimeStatus.supports?.loadSession === true,
        cancellation: true,
        tools: true,
        toolPolicies: ['none', 'read-only', 'standard'],
        available: runtimeStatus.available === true,
        ...(runtimeStatus.available === true
          ? {
              runtime: {
                version: runtimeStatus.version ?? null,
                acpProtocolVersion: runtimeStatus.acpProtocolVersion ?? null,
                mcpTransports: runtimeStatus.supports?.mcpTransports ?? ['stdio'],
              },
            }
          : { unavailableReason: publicProbeReason(runtimeStatus) }),
      }
    },

    start(request, handlers) {
      let controller = null
      let clientServices = null
      let terminal = false
      let cancelled = false
      let disposed = false

      const done = (result) => {
        if (terminal || disposed) return
        terminal = true
        handlers.onDone(completion(result))
      }
      const fail = (error) => {
        if (terminal || disposed) return
        terminal = true
        clientServices?.dispose()
        handlers.onError(error?.message || 'Kiro Agent gagal dimulai.', error)
      }

      Promise.resolve().then(async () => {
        const status = await ready
        if (!status.available) {
          throw Object.assign(new Error(publicProbeReason(status)), {
            code: status.code ?? 'KIRO_ACP_UNAVAILABLE',
          })
        }
        const [auth, workspace, mcpServers] = await Promise.all([
          authForRequest(request),
          getWorkspace(request.workspaceId),
          getMcpServers(request.mcpServerIds, { policy: request.toolPolicy }),
        ])
        assertMcpTransportsSupported(mcpServers, status)
        if (disposed) return
        if (cancelled) {
          done({ reason: 'cancelled', sessionId: request.sessionId })
          return
        }

        const guard = createToolPolicyGuard(request.toolPolicy)
        clientServices = createAcpClientServices({
          workspaceRoot: workspace.root,
          policy: request.toolPolicy,
          guard,
        })
        controller = runner.start({
          ...request,
          auth,
          cwd: workspace.root,
          allowTools: request.toolPolicy !== 'none',
          clientServices,
          mcpServers,
        }, {
          onSession: handlers.onSession,
          onChunk: handlers.onChunk,
          onThought: handlers.onThought,
          onPlan: handlers.onPlan,
          onToolCall: handlers.onToolCall,
          onDiagnostic: handlers.onDiagnostic,
          onPermissionRequest: handlers.onPermissionRequest,
          onDone: done,
          onError: (message, error) => fail(error ?? new Error(message)),
        })
      }).catch(fail)

      return {
        cancel() {
          if (terminal || cancelled || disposed) return
          cancelled = true
          if (controller) controller.cancel()
        },
        dispose() {
          if (terminal || disposed) return
          disposed = true
          if (controller) controller.dispose()
          else clientServices?.dispose()
        },
      }
    },
  }
}
