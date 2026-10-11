import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Tables } from './player.js'

// CBT3's current client uses server-controlled 998xxx activity time IDs.
// Older external exports used 100xx IDs, which the current UI never queries.
// Keep the versioned MMap extraction and its provenance under configs, not data.
export function activityTables(external) {
    const directory = fileURLToPath(new URL('../configs/activity-tables/', import.meta.url))
    const source = JSON.parse(fs.readFileSync(new URL('../configs/activity-tables/source.json', import.meta.url)))
    const names = new Set(source.tables.map((row) => row.name))
    const current = new Tables(directory)
    return {
        get: (name) => (names.has(name) ? current.get(name) : external.get(name)),
        find: (name, id) => (names.has(name) ? current.find(name, id) : external.find(name, id)),
    }
}
