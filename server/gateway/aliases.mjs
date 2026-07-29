import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Peta alias model → target. Target boleh berupa:
 *   - "connection-id/upstream-model"  (eksplisit, dengan kandidat failover)
 *   - "upstream-model"                (bare, gateway pilih connection mana pun
 *                                      yang mengekspos model itu)
 *
 * Sumber: env GATEWAY_ALIASES (JSON string) di-merge dengan file
 * .data/gateway/aliases.json. Format:
 *   { "gpt-4o": "openrouter/openai/gpt-4o", "fast": "groq/llama-3.1-8b" }
 */
function coerceAliasMap(raw) {
  const map = {}
  if (!raw || typeof raw !== 'object') return map
  for (const [alias, target] of Object.entries(raw)) {
    if (typeof alias === 'string' && alias.trim() && typeof target === 'string' && target.trim()) {
      map[alias.trim()] = target.trim()
    }
  }
  return map
}

export function parseAliasesFromEnv(envValue) {
  if (typeof envValue !== 'string' || !envValue.trim()) return {}
  try {
    return coerceAliasMap(JSON.parse(envValue))
  } catch {
    return {}
  }
}

export async function loadAliases({ dataDir, aliasFile, envValue } = {}) {
  const fromEnv = parseAliasesFromEnv(envValue)
  const path = aliasFile ?? (dataDir ? join(dataDir, 'aliases.json') : null)
  let fromFile = {}
  if (path) {
    try {
      fromFile = coerceAliasMap(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      // tidak ada file / JSON rusak → abaikan
    }
  }
  // File override env bila bentrok.
  return { ...fromEnv, ...fromFile }
}
