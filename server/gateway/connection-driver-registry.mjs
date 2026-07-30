export function createConnectionDriverRegistry(initialDrivers = []) {
  const driversById = new Map()
  const driversByKind = new Map()

  function register(driver) {
    if (!driver?.id || typeof driver.attempt !== 'function') {
      throw new TypeError('Connection driver harus punya id dan attempt(request)')
    }
    const kinds = Array.isArray(driver.kinds) && driver.kinds.length
      ? driver.kinds
      : [driver.id]
    if (driversById.has(driver.id)) {
      throw new Error(`Connection driver duplikat: ${driver.id}`)
    }
    for (const kind of kinds) {
      if (typeof kind !== 'string' || !kind) {
        throw new TypeError(`Connection driver ${driver.id} punya kind tidak valid`)
      }
      if (driversByKind.has(kind)) {
        throw new Error(`Connection kind ${kind} sudah ditangani driver lain`)
      }
    }

    driversById.set(driver.id, driver)
    for (const kind of kinds) driversByKind.set(kind, driver)
    return driver
  }

  function forConnection(connection) {
    return driversByKind.get(connection?.kind) ?? null
  }

  function list() {
    return [...driversById.values()]
  }

  for (const driver of initialDrivers) register(driver)
  return { register, forConnection, list }
}
