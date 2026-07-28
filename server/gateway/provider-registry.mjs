const providers = new Map()

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.start !== 'function') {
    throw new TypeError('Provider gateway harus punya id dan start(request, handlers)')
  }
  if (providers.has(provider.id)) {
    throw new Error(`Provider gateway duplikat: ${provider.id}`)
  }
  providers.set(provider.id, provider)
  return provider
}

export function getProvider(id) {
  return providers.get(id) ?? null
}

export function listProviders() {
  return [...providers.values()].map(({ id, label, capabilities }) => ({
    id,
    label,
    capabilities,
  }))
}
