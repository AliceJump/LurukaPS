import { u64 } from './combat-state.js'

function active(c) {
    const run = c.state.combat?.npcDuel
    return run && run.map_id === c.state.world.map_id && !run.result && run.entities_sent !== false ? run : null
}

// AddSnapshot keeps the first value for each entity/key, not a refcounted
// private copy for every element which later refers to that key.
export function createArenaSnapshot(c, ownerId, keyId, captures) {
    const run = active(c),
        owner = u64(ownerId),
        key = u64(keyId)
    if (!run || owner === '0' || key === '0' || run.snapshot_owners?.[owner]) return false
    const values = { ...run.arena_snapshots?.[key] }
    for (const [uuid, value] of Object.entries(captures))
        if (!Object.hasOwn(values, uuid)) values[uuid] = structuredClone(value)
    c.state.combat.npcDuel = {
        ...run,
        arena_snapshots: { ...run.arena_snapshots, [key]: values },
        snapshot_owners: { ...run.snapshot_owners, [owner]: { key, entities: Object.keys(captures), ended: false } },
    }
    return true
}

// Callers must prove inheritance before binding; no attributes are captured by
// this operation. This primitive is not itself a runtime injection resolver.
export function bindArenaSnapshot(c, ownerId, keyId, entities) {
    const run = active(c),
        owner = u64(ownerId),
        key = u64(keyId)
    if (!run || owner === '0' || run.snapshot_owners?.[owner]) return false
    c.state.combat.npcDuel = {
        ...run,
        snapshot_owners: {
            ...run.snapshot_owners,
            [owner]: { key, entities: [...new Set(entities.map(u64))], ended: false },
        },
    }
    return true
}

export function releaseArenaSnapshot(c, ownerId) {
    const run = active(c),
        owner = u64(ownerId),
        entry = run?.snapshot_owners?.[owner]
    if (!entry || entry.ended) return false
    const values = { ...run.arena_snapshots?.[entry.key] },
        snapshots = { ...run.arena_snapshots }
    for (const uuid of entry.entities) delete values[uuid]
    if (Object.keys(values).length) snapshots[entry.key] = values
    else delete snapshots[entry.key]
    c.state.combat.npcDuel = {
        ...run,
        arena_snapshots: snapshots,
        snapshot_owners: { ...run.snapshot_owners, [owner]: { ...entry, ended: true } },
    }
    return true
}

export function arenaSnapshotView(c, ownerId) {
    const run = active(c),
        entry = run?.snapshot_owners?.[u64(ownerId)]
    if (!entry) return { status: 'unobserved' }
    const captures = run.arena_snapshots?.[entry.key] ?? {}
    return {
        status: 'known',
        key: entry.key,
        ended: entry.ended,
        captures,
        missing: entry.entities.filter((uuid) => !Object.hasOwn(captures, uuid)),
    }
}

export function recordArenaSnapshotLifetime(c, event) {
    let run = active(c)
    if (!run) return
    const id = u64(event.uniqueId)
    if (event.op === 2) {
        releaseArenaSnapshot(c, id)
        return
    }
    let record = run.damage_elements?.[id]
    if (!record) return
    const owner = run.snapshot_owners?.[id]
    if (event.op === 1 && ['own', 'inherited'].includes(record.snapshot_mode) && record.snapshot_observed) {
        if (record.ended) return // Legacy ended inputs do not prove a live manager key.
        if (record.snapshot_registry) return // Retrying Add must not recapture.
        if (owner) {
            record = {
                ...record,
                snapshot_observed: false,
                before_execution: undefined,
                execution_kind: 'unresolved-replay',
            }
        } else {
            if (record.snapshot_mode === 'inherited') {
                const proof = record.snapshot_policy_evidence
                if (proof?.policy !== 'parent-before-parse' || proof.key !== '0') return
                const entities = [record.attacker, record.source, record.target].filter(
                    (uuid) => run.actors[uuid]?.base_properties,
                )
                bindArenaSnapshot(c, id, '0', entities)
                record = {
                    ...record,
                    snapshot_registry: true,
                    snapshot_key: '0',
                    snapshot_missing: [...new Set(entities)],
                }
            } else {
                const direct = record.parent === '0' && [1, 3].includes(record.verify_info?.source_type)
                if (!direct && record.snapshot_policy_evidence?.policy !== 'own') return
                createArenaSnapshot(c, id, id, record.snapshots)
                record = { ...record, snapshot_registry: true, snapshot_key: id, snapshot_missing: [] }
            }
        }
    } else if (
        [8, 9].includes(event.op) &&
        owner &&
        !owner.ended &&
        record.snapshot_registry &&
        ['tick', 'end'].includes(record.execution_kind) &&
        !record.ended
    ) {
        const view = arenaSnapshotView(c, id)
        record = { ...record, snapshots: structuredClone(view.captures), snapshot_missing: view.missing }
    } else return
    run = c.state.combat.npcDuel
    c.state.combat.npcDuel = { ...run, damage_elements: { ...run.damage_elements, [id]: record } }
}
