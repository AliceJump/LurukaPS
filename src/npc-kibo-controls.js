import { arenaContext, arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { u64 } from './combat-state.js'
const { elements } = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-controls.json', import.meta.url), 'utf8'))
const time = (c) =>
    BigInt(c.state.combat.npcDuel.pause ? secondsToArenaMs(c.state.combat.npcDuel.pause.server_at) : arenaMillis(c))
const active = (c, effect) => effect.expires_ms === null || BigInt(effect.expires_ms) > time(c)

//10706's receive path differs from the client's report encoder: op10 keeps
// an absolute begin_time and cfg_id is indexed only for op1/10. Replay op10
// deliberately executes the local control, rather than its visual-only remote
// variant. The server ends the restored instance at its original deadline.
export function arenaElementPacket(rows) {
    const dictionary = [],
        indexes = new Map()
    const index = (value) => {
        const id = u64(value)
        if (id === '0') return '0'
        if (!indexes.has(id)) {
            dictionary.push(id)
            indexes.set(id, String(dictionary.length))
        }
        return indexes.get(id)
    }
    const battle_info = rows.map((raw) => {
        const { updated_at, ...wire } = raw
        const row = structuredClone(wire),
            buff = (row.buff ??= {})
        row.tar_id = index(row.tar_id)
        row.uniqueId = index(row.uniqueId)
        if (row.parentUniqueId !== undefined) row.parentUniqueId = index(row.parentUniqueId)
        for (const key of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
            if (buff[key] !== undefined) buff[key] = index(buff[key])
        if ([1, 10].includes(row.op)) buff.cfg_id = Number(index(buff.cfg_id))
        for (const entry of buff.entrys ?? [])
            if ([3, 4].includes(entry.key)) entry.ui64_dic_values = (entry.ui64_dic_values ?? []).map(index)
        return { element_info: row }
    })
    return { base_time: '0', uint64_dic: dictionary, battle_info }
}

function clearReplayed(c, entries) {
    const run = c.state.combat.npcDuel,
        replay = { ...run.control_replays },
        rows = []
    for (const [id, effect] of entries)
        if (replay[id]?.active) {
            rows.push({
                op: 2,
                uniqueId: id,
                tar_id: effect.target,
                buff: { executor_id: effect.target, attacker_id: '0' },
            })
            replay[id] = { ...replay[id], active: false, awaiting: false, ended: true }
        }
    if (rows.length) {
        c.pushBefore('SCProtoBattleInfoReduceNtf', arenaElementPacket(rows))
        c.state.combat.npcDuel = { ...run, control_replays: replay }
    }
}

export function publishArenaControls(c) {
    c = arenaContext(c)
    let run = c.state.combat?.npcDuel
    if (!run || run.result || run.control_replay_done || run.map_id !== c.state.world.map_id) return
    advanceArenaControls(c)
    run = c.state.combat.npcDuel
    const rows = [],
        replay = { ...run.control_replays },
        missing = []
    const knownActor = (id) => !!run.actors[id] || id === run.trainer_guid || id === String(run.npc_id)
    for (const [id, effect] of Object.entries(run.controls ?? {})) {
        const spec = elements[effect.config_id],
            raw = c.state.combat.elements[id]
        if (
            !spec ||
            !raw?.buff ||
            !active(c, effect) ||
            effect.layer === 0 ||
            !run.in_fight[effect.target] ||
            c.state.combat.entities[effect.target]?.hp === 0
        )
            continue
        if (spec.kind === 'lock' && run.lock_selectors?.[effect.target] !== id) continue
        if (
            spec.taunt &&
            run.taunt_selectors?.[effect.target]?.uid !== id &&
            !spec.block_move &&
            !spec.block_skill &&
            !spec.blocked_slots.length
        )
            continue
        const attacker = String(raw.buff.attacker_id ?? '0')
        if (!knownActor(attacker)) {
            missing.push(id)
            continue
        }
        rows.push({
            ...structuredClone(raw),
            op: 10,
            buff: { ...structuredClone(raw.buff), executor_id: effect.target, attacker_id: attacker },
            verify_info: {
                battle_index: '0',
                related_index: '0',
                source_type: 12,
                source_id: '0',
                op_time: String(arenaMillis(c)),
            },
        })
        replay[id] = { active: true, awaiting: true, config_id: effect.config_id, target: effect.target }
    }
    if (rows.length) c.pushBefore('SCProtoBattleInfoReduceNtf', arenaElementPacket(rows))
    if (missing.length)
        console.warn(`[npc-arena] Control replay lacks an available attacker: ${missing.length} element(s)`)
    c.state.combat.npcDuel = {
        ...run,
        control_replays: replay,
        control_replay_done: true,
        control_replay_missing_sources: missing.length,
    }
}

export function recordArenaControlEvent(c, event) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel,
        id = String(event.uniqueId)
    if (!run || run.map_id !== c.state.world.map_id || run.result) return
    const previous = run.controls?.[id]
    const replayed = run.control_replays?.[id]
    if (event.op === 2) {
        if (!previous) return
        const controls = { ...run.controls },
            locks = { ...run.lock_selectors },
            taunts = { ...run.taunt_selectors }
        delete controls[id]
        // Native ChangeLockTargetElement.OnReset disables the selector; it
        // does not restore an earlier element's settings from a stack.
        if (elements[previous.config_id]?.kind === 'lock') delete locks[previous.target]
        if (elements[previous.config_id]?.taunt) delete taunts[previous.target]
        c.state.combat.npcDuel = {
            ...run,
            controls,
            lock_selectors: locks,
            taunt_selectors: taunts,
            ...(replayed
                ? {
                      control_replays: {
                          ...run.control_replays,
                          [id]: { ...replayed, active: false, awaiting: false, ended: true },
                      },
                  }
                : {}),
        }
        return
    }
    if (![1, 3, 7, 10].includes(event.op)) return
    const data = c.state.combat.elements[id],
        buff = data?.buff,
        spec = elements[buff?.cfg_id]
    const target = data?.tar_id
    const restoreEcho =
        (event.op === 1 || (event.op === 7 && event.verify_info?.source_type === 12)) &&
        replayed?.config_id === buff?.cfg_id &&
        replayed.target === target
    if (restoreEcho && replayed.ended) {
        const raw = { ...c.state.combat.elements }
        delete raw[id]
        c.state.combat.elements = raw
        return
    }
    if (!spec || !run.actors[target]) {
        if (previous) {
            const controls = { ...run.controls },
                locks = { ...run.lock_selectors },
                taunts = { ...run.taunt_selectors }
            delete controls[id]
            if (elements[previous.config_id]?.kind === 'lock') delete locks[previous.target]
            if (elements[previous.config_id]?.taunt) delete taunts[previous.target]
            c.state.combat.npcDuel = { ...run, controls, lock_selectors: locks, taunt_selectors: taunts }
        }
        return
    }
    const begin = u64(buff.begin_time),
        duration = u64(buff.total_time)
    const same = previous?.config_id === buff.cfg_id && previous.begin_ms === begin && previous.duration_ms === duration
    const expires = BigInt(duration) > 0n ? ((BigInt(begin) || time(c)) + BigInt(duration)).toString() : null
    const effect = {
        config_id: buff.cfg_id,
        target,
        begin_ms: begin,
        duration_ms: duration,
        expires_ms:
            restoreEcho && replayed.awaiting && previous ? previous.expires_ms : same ? previous.expires_ms : expires,
        layer: buff.layer ?? previous?.layer ?? 1,
        attacker: u64(buff.attacker_id),
    }
    const controls = { ...run.controls, [id]: effect },
        locks = { ...run.lock_selectors },
        taunts = { ...run.taunt_selectors }
    if (
        previous &&
        (previous.config_id !== buff.cfg_id || previous.target !== target) &&
        elements[previous.config_id]?.kind === 'lock'
    )
        delete locks[previous.target]
    if (
        previous &&
        (previous.config_id !== buff.cfg_id || previous.target !== target) &&
        elements[previous.config_id]?.taunt
    )
        delete taunts[previous.target]
    ensure(Object.keys(controls).length <= 2048, 'Too many arena control elements')
    if (spec.kind === 'lock' && (!same || !previous) && active(c, effect)) locks[target] = id
    if (
        spec.taunt &&
        (!previous || previous.config_id !== buff.cfg_id || previous.target !== target) &&
        effect.attacker !== '0' &&
        active(c, effect)
    )
        taunts[target] = { uid: id, attacker: effect.attacker }
    let petAI = run.pet_ai
    if (spec.block_move && spec.apply_to !== 2 && effect.layer > 0 && active(c, effect) && petAI?.[target]?.moving) {
        c.pushBefore('SCProtoKiboStopMove', { uuid: target })
        petAI = { ...petAI, [target]: { ...petAI[target], moving: false } }
    }
    c.state.combat.npcDuel = {
        ...run,
        controls,
        lock_selectors: locks,
        taunt_selectors: taunts,
        pet_ai: petAI,
        ...(restoreEcho && replayed.awaiting
            ? { control_replays: { ...run.control_replays, [id]: { ...replayed, awaiting: false } } }
            : {}),
    }
}

export function advanceArenaControls(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run?.controls || run.pause) return
    const expired = Object.entries(run.controls).filter(
        ([, effect]) => !elements[effect.config_id] || !active(c, effect) || effect.layer === 0,
    )
    if (!expired.length) return
    clearReplayed(c, expired)
    const current = c.state.combat.npcDuel
    const controls = { ...run.controls },
        locks = { ...run.lock_selectors },
        taunts = { ...run.taunt_selectors },
        raw = { ...c.state.combat.elements }
    for (const [id, effect] of expired) {
        delete controls[id]
        if (elements[effect.config_id]?.kind === 'lock') delete locks[effect.target]
        if (elements[effect.config_id]?.taunt) delete taunts[effect.target]
        if (raw[id]?.buff?.cfg_id === effect.config_id && raw[id].tar_id === effect.target) delete raw[id]
    }
    c.state.combat.npcDuel = { ...current, controls, lock_selectors: locks, taunt_selectors: taunts }
    c.state.combat.elements = raw
}

export function arenaControlState(c, uuid) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel,
        blocked_slots = new Set()
    let can_move = true,
        can_skill = true
    for (const effect of Object.values(run.controls ?? {})) {
        const spec = elements[effect.config_id]
        if (
            !spec ||
            effect.target !== uuid ||
            effect.layer === 0 ||
            !active(c, effect) ||
            spec.kind !== 'control' ||
            spec.apply_to === 2
        )
            continue
        can_move &&= !spec.block_move
        can_skill &&= !spec.block_skill
        for (const slot of spec.blocked_slots) blocked_slots.add(slot)
    }
    return { can_move, can_skill, blocked_slots }
}

export function arenaLockSelector(c, uuid) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel,
        id = run.lock_selectors?.[uuid],
        effect = run.controls?.[id]
    const spec = elements[effect?.config_id]
    return effect && spec?.kind === 'lock' && effect.layer > 0 && active(c, effect) ? spec : null
}

export function arenaTauntTarget(c, uuid) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel,
        selector = run.taunt_selectors?.[uuid],
        effect = run.controls?.[selector?.uid]
    if (!effect || effect.layer === 0 || !active(c, effect)) return null
    const attacker = selector.attacker
    // In-fight contestants are the visible/alive objects this NPC runtime
    // can resolve. Never retarget to a missing or retired source identity.
    return run.in_fight[attacker] && c.state.combat.entities[attacker]?.hp > 0 ? run.actors[attacker] : null
}

export function arenaPriorityTarget(c, actor, enemies, range) {
    c = arenaContext(c)
    const policy = arenaLockSelector(c, actor.uuid)
    if (!policy || policy.apply_to === 2) return null
    const run = c.state.combat.npcDuel,
        source = run.in_fight[actor.uuid].move.pos
    let target,
        best = policy.priority === 1 ? -Infinity : Infinity
    for (const other of [...enemies].sort((a, b) => a.slot - b.slot)) {
        const category = c.tables.find('pet', other.config_id).kiboType,
            pos = run.in_fight[other.uuid].move.pos
        if (
            !((1 << (category & 31)) & policy.pet_types) ||
            Math.hypot(source.x - pos.x, source.y - pos.y, source.z - pos.z) / 100 > range
        )
            continue
        const hp = c.state.combat.entities[other.uuid].hp
        const value = policy.property === 10000 ? hp : hp / other.max_hp
        if (!policy.property || (policy.priority === 1 ? value > best : value < best)) {
            target = other
            best = value
        }
    }
    return { target, only_select: policy.only_select }
}

export function clearArenaCardControls(c, uuid) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel
    const frozen = Object.entries(run.controls ?? {}).filter(
        ([, effect]) => effect.target === uuid && elements[effect.config_id]?.preset === 3,
    )
    if (!frozen.length) return
    clearReplayed(c, frozen)
    const current = c.state.combat.npcDuel
    const controls = { ...run.controls },
        raw = { ...c.state.combat.elements }
    for (const [id, effect] of frozen) {
        delete controls[id]
        if (raw[id]?.buff?.cfg_id === effect.config_id && raw[id].tar_id === effect.target) delete raw[id]
    }
    c.state.combat.npcDuel = { ...current, controls }
    c.state.combat.elements = raw
}
