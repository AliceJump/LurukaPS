import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaProperty } from './npc-kibo-properties.js'

const roles = { attacker: 'attacker', source: 'source', target: 'target' }

export function arenaExecutionState(c, input) {
    ensure(input.status === 'ready', 'Arena execution input is unresolved', ErrorCode.InvalidLogic)
    const run = c.state.combat?.npcDuel,
        record = input.record
    ensure(
        run && run.map_id === c.state.world.map_id && !run.result && run.entities_sent !== false,
        'No active arena execution properties',
        ErrorCode.InvalidLogic,
    )
    // An old input retained by a caller cannot cross a client entity rebuild.
    ensure(run.damage_elements?.[record.id] === record, 'Arena execution input is stale', ErrorCode.InvalidLogic)
    return run
}

function selection(c, input, role, mode, phase) {
    // 'after' reads the latest accepted state. The caller must separately
    // establish that all relevant native triggers have finished reporting.
    const run = arenaExecutionState(c, input),
        record = input.record
    ensure(Object.hasOwn(roles, role), 'Arena execution property role unavailable', ErrorCode.GameConfig)
    ensure(['snapshot-aware', 'live'].includes(mode), 'Arena execution property mode unavailable', ErrorCode.GameConfig)
    ensure(['before', 'after'].includes(phase), 'Arena execution property phase unavailable', ErrorCode.GameConfig)
    const uuid = record[roles[role]],
        actor = run.actors[uuid]
    ensure(actor?.base_properties, 'Arena execution property actor unavailable', ErrorCode.InvalidLogic)
    const native = mode === 'snapshot-aware' && ['own', 'inherited'].includes(record.snapshot_mode)
    if (native)
        ensure(record.snapshot_observed === true, 'Arena original snapshot was not observed', ErrorCode.InvalidLogic)
    ensure(
        mode === 'live' || ['none', 'own', 'inherited'].includes(record.snapshot_mode),
        'Arena inherited snapshot unavailable',
        ErrorCode.InvalidLogic,
    )
    const captured = native ? record.snapshots?.[uuid] : phase === 'before' ? record.before_execution?.[uuid] : null
    const missing = native && record.snapshot_registry === true && record.snapshot_missing?.includes(uuid)
    if ((native || phase === 'before') && !missing)
        ensure(captured, 'Arena execution property capture unavailable', ErrorCode.InvalidLogic)
    return { uuid, actor, captured, native, missing }
}

export function arenaExecutionProperty(
    c,
    input,
    role,
    id,
    normalized = true,
    mode = 'snapshot-aware',
    phase = 'before',
    tags = null,
    component = 0,
) {
    const selected = selection(c, input, role, mode, phase)
    ensure(Number.isInteger(component) && component >= 0 && component <= 6, 'Unknown arena property component')
    if (selected.missing) return 0 // An observed RemoveSnapShot, not missing server evidence.
    const snapshot = selected.captured
        ? {
              ...selected.captured,
              base_properties: selected.actor.base_properties,
              native_snapshot: selected.native,
          }
        : null
    return arenaProperty(c, selected.uuid, id, undefined, normalized, tags, component, snapshot)
}

export function arenaExecutionResource(c, input, role, resource, mode = 'snapshot-aware', phase = 'before') {
    ensure(['hp', 'sp'].includes(resource), 'Arena execution resource unavailable', ErrorCode.GameConfig)
    const selected = selection(c, input, role, mode, phase)
    if (selected.missing) return 0
    const value = (selected.captured ?? c.state.combat.entities[selected.uuid])?.[resource]
    ensure(Number.isFinite(value), 'Arena execution resource capture unavailable', ErrorCode.InvalidLogic)
    return Math.fround(value)
}
