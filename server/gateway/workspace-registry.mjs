import { stat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i

export function createWorkspaceRegistry({ workspaces, defaultRoot = process.cwd() } = {}) {
  const entries = new Map()

  function register(input) {
    const id = String(input?.id ?? '').trim()
    if (!SAFE_ID_PATTERN.test(id)) throw new Error('Workspace id tidak valid')
    if (entries.has(id)) throw new Error(`Workspace duplikat: ${id}`)
    const root = resolve(String(input?.root ?? ''))
    entries.set(id, {
      id,
      name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id,
      root,
    })
  }

  const configured = Array.isArray(workspaces) && workspaces.length
    ? workspaces
    : [{ id: 'default', name: 'Default workspace', root: defaultRoot }]
  for (const workspace of configured) register(workspace)

  async function get(id = 'default') {
    const entry = entries.get(id)
    if (!entry) throw Object.assign(new Error(`Workspace tidak ditemukan: ${id}`), {
      code: 'WORKSPACE_NOT_FOUND',
    })
    let root
    try {
      root = await realpath(entry.root)
      const metadata = await stat(root)
      if (!metadata.isDirectory()) throw new Error('bukan directory')
    } catch (cause) {
      throw Object.assign(new Error(`Workspace tidak dapat diakses: ${entry.id}`), {
        code: 'WORKSPACE_UNAVAILABLE',
        cause,
      })
    }
    return { ...entry, root }
  }

  function list() {
    return [...entries.values()].map(({ id, name }) => ({ id, name }))
  }

  return { register, get, list }
}
