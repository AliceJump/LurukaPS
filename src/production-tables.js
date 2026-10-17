import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Tables } from './player.js'

const directory = fileURLToPath(new URL('../configs/production-tables/', import.meta.url))
const source = JSON.parse(fs.readFileSync(new URL('../configs/production-tables/source.json', import.meta.url)))
const names = new Set(source.tables.map((row) => row.name))
const current = new Tables(directory)
const adapters = new WeakMap()
const wrapped = new WeakSet()

// CBT3 2451868 removed obsolete coin costs and changed several other recipes.
// All consumers read the same recipes. Jobs retain the costs actually paid,
// so cancelling a legacy job still refunds its original debit exactly.
export function productionTables(external) {
    if (wrapped.has(external)) return external
    if (!adapters.has(external)) {
        const adapter = Object.create(external)
        adapter.get = (name) => (names.has(name) ? current.get(name) : external.get(name))
        adapter.find = (name, id) => (names.has(name) ? current.find(name, id) : external.find(name, id))
        adapters.set(external, adapter)
        wrapped.add(adapter)
    }
    return adapters.get(external)
}
