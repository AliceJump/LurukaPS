import { ErrorCode } from './error-codes.js'
import { arenaContext, arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'
import { arenaPetSkills, arenaSkillLogic } from './kibo-arena-attributes.js'
import { ensure, GameError } from './handlers/common.js'
import { boundedSet } from './combat-state.js'
import { arenaProperty, mergeArenaProperties } from './npc-kibo-properties.js'

const catalogs = new WeakMap()
const F = Math.fround,
    SP_STEP_MS = 100
const fixed = (value) => BigInt(Math.trunc(F(F(value) * 65536)))
const float = (value) => F(F(Number(value)) / 65536)

// SPSystem.Initialize starts with0.1 seconds remaining. Its field/background
// step multiplies in MyFloat before converting to float for RecoverSP.
export function arenaPassiveSpStep(c, uuid, field) {
    const actor = c.state.combat.npcDuel.actors[uuid]
    const rate = field
        ? BigInt.asIntN(
              64,
              fixed(arenaSpConfig(c.tables, actor.config_id).passive) + fixed(arenaProperty(c, uuid, 110, 0, false)),
          )
        : fixed(arenaProperty(c, uuid, 226, 0, false))
    const step = float(BigInt.asIntN(64, (rate * fixed(0.1)) >> 16n))
    return F(step * F(1 + arenaProperty(c, uuid, 227)))
}

function spClock(c, actor, now) {
    const run = c.state.combat.npcDuel
    const clock = run.pet_sp?.[actor.uuid] ?? {
        milli: (c.state.combat.entities[actor.uuid]?.sp ?? arenaSpConfig(c.tables, actor.config_id).initial) * 1000,
        at: secondsToArenaMs(run.regular_started_at ?? c.now),
        lock_until: 0,
    }
    // Existing saves have an at watermark but no fractional update phase.
    const origin = secondsToArenaMs(run.regular_started_at ?? now / 1000)
    return { ...clock, remainder_ms: clock.remainder_ms ?? Math.max(0, clock.at - origin) % SP_STEP_MS }
}
export function arenaSpConfig(tables, petId) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = {
            pets: new Map(),
            passive: Number(tables.get('game').find((row) => row.title === 'KiBo_Passive_Sp_Regen')?.value),
        }
        ensure(
            Number.isFinite(catalog.passive) && catalog.passive >= 0,
            'Arena SP regeneration unavailable',
            ErrorCode.GameConfig,
        )
        catalogs.set(tables, catalog)
    }
    if (!catalog.pets.has(petId)) {
        const skills = arenaPetSkills(tables, petId).map((skill) => ({
            ...skill,
            logic: arenaSkillLogic(tables, skill.skill_id),
        }))
        const ultimate = skills.find((skill) => skill.skill_slot === 206)
        ensure(ultimate?.logic?.kiBoSpMax > 0, 'Arena ultimate energy configuration unavailable', ErrorCode.GameConfig)
        catalog.pets.set(petId, {
            skills,
            ultimate,
            max: ultimate.logic.kiBoSpMax,
            initial: ultimate.logic.kiBoInitialSp,
            passive: catalog.passive,
        })
    }
    return catalog.pets.get(petId)
}

function putSp(c, uuid, milli, clock) {
    const run = c.state.combat.npcDuel,
        actor = run.actors[uuid]
    const max = Math.max(0, arenaProperty(c, uuid, 6, arenaSpConfig(c.tables, actor.config_id).max)) * 1000
    const value = float(fixed(Math.max(0, Math.min(max / 1000, F(milli / 1000))))) * 1000
    c.state.combat.entities = {
        ...c.state.combat.entities,
        [uuid]: { ...c.state.combat.entities[uuid], sp: Math.floor(value / 1000) },
    }
    c.state.combat.npcDuel = { ...run, pet_sp: { ...run.pet_sp, [uuid]: { ...clock, milli: value } } }
}

export function advanceArenaSp(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (
        !run ||
        run.pause ||
        run.map_id !== c.state.world.map_id ||
        c.state.multiCampaign?.arena_status !== 4 ||
        run.result
    )
        return
    const now = arenaMillis(c)
    for (const actor of Object.values(run.actors)) {
        const current = c.state.combat.npcDuel,
            clock = spClock(c, actor, now)
        const field = current.in_fight[actor.uuid]
        const from = Math.max(
            clock.at,
            secondsToArenaMs(current.regular_started_at ?? c.now),
            secondsToArenaMs(c.state.world.pause?.updated_at ?? 0),
        )
        const total = clock.remainder_ms + Math.max(0, now - from),
            steps = Math.floor(total / SP_STEP_MS),
            firstAt = from + SP_STEP_MS - clock.remainder_ms,
            locked = Math.max(0, Math.ceil((clock.lock_until - firstAt) / SP_STEP_MS))
        let milli = clock.milli
        if (c.state.combat.entities[actor.uuid]?.hp > 0 && !c.state.world.pause?.operate && steps > locked) {
            const gain = arenaPassiveSpStep(c, actor.uuid, !!field),
                max = Math.max(0, arenaProperty(c, actor.uuid, 6, arenaSpConfig(c.tables, actor.config_id).max))
            // A delayed server poll batches discrete steps, not one large
            // floating-point recovery. Clamp and SetSp quantize each step.
            for (let step = locked; step < steps; step++) {
                const value = float(fixed(Math.max(0, Math.min(max, F(F(milli / 1000) + gain)))))
                const unchanged = value * 1000 === milli
                milli = value * 1000
                if (unchanged || value === max || (value === 0 && gain <= 0)) break
            }
        }
        putSp(c, actor.uuid, milli, {
            ...clock,
            at: Math.max(clock.at, now),
            remainder_ms: total % SP_STEP_MS,
        })
    }
}

export function applyArenaCast(c, actor, skill, origin = 'server', networkIndex = '0') {
    c = arenaContext(c)
    const now = arenaMillis(c)
    const clock = spClock(c, actor, now)
    const cost = skill.logic.kiBoSpMax * 1000
    if (clock.milli < cost) {
        const run = c.state.combat.npcDuel,
            error = new GameError('Arena ultimate energy is insufficient')
        error.arenaSpContext = {
            duel_id: run.duel_id,
            uuid: actor.uuid,
            pet_id: actor.config_id,
            skill_id: skill.skill_id,
            slot: skill.skill_slot,
            origin,
            network_index: networkIndex,
            at_ms: now,
            available_milli: clock.milli,
            cost_milli: cost,
            last_published_sp: run.pet_sp_sent?.[actor.uuid],
            clock: { ...clock },
            active_cast: run.arena_casts?.[actor.uuid] && { ...run.arena_casts[actor.uuid] },
            entry_report: run.entry_reports?.[actor.uuid] && { ...run.entry_reports[actor.uuid] },
            entered_at: run.in_fight[actor.uuid]?.entered_at,
        }
        throw error
    }
    const gain =
        [1, 2].includes(skill.skill_slot) && now >= clock.lock_until
            ? skill.logic.kiBoAttackSp * (1 + arenaProperty(c, actor.uuid, 105)) * 1000
            : 0
    putSp(c, actor.uuid, clock.milli - cost + gain, {
        ...clock,
        at: now,
        lock_until: skill.skill_slot === 206 ? now + skill.logic.kiBoVersusCoolDown : clock.lock_until,
    })
    const current = c.state.combat.npcDuel
    c.state.combat.npcDuel = {
        ...current,
        arena_casts: {
            ...current.arena_casts,
            [actor.uuid]: {
                skill_id: skill.skill_id,
                slot: skill.skill_slot,
                origin,
                network_index: networkIndex,
                at: now,
                ended: false,
            },
        },
    }
}

export function recordArenaSkillStart(c, uuid, request) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel,
        actor = run?.actors[uuid]
    if (!actor || run.map_id !== c.state.world.map_id) return
    if (run.result || run.entities_sent === false || !run.in_fight[uuid] || c.state.multiCampaign?.arena_status !== 4)
        return
    const index = String(request.verify_info?.battle_index ?? '0'),
        active = run.arena_casts?.[uuid]
    const eventTime = Number(request.op_time ?? request.verify_info?.op_time ?? 0)
    if (
        eventTime > 0 &&
        eventTime < secondsToArenaMs(run.in_fight[uuid].entered_report_at ?? run.in_fight[uuid].entered_at ?? 0)
    )
        return
    const network = request.verify_info?.source_type === 5
    if (network) {
        // OnSyncStartSkill emits a fresh11100 with source_type5. It is an
        // acknowledgement of11101, never a second SP gain/cost.
        if (
            active &&
            !active.ended &&
            active.skill_id === request.skill.skill_id &&
            (!eventTime || eventTime >= active.at)
        ) {
            c.state.combat.npcDuel = {
                ...run,
                arena_casts: { ...run.arena_casts, [uuid]: { ...active, network_index: index } },
            }
        }
        return
    }
    if (run.pause) return
    // The active animation can be replaced before an older11100 is retried.
    // A paid cast remains paid independently of the latest animation slot.
    const receiptKey = `${uuid}:${index}`,
        receipt = index !== '0' && run.arena_cast_receipts?.[receiptKey]
    if (receipt) {
        ensure(receipt.skill_id === request.skill.skill_id, 'Arena skill cast index conflict')
        return false
    }
    if (active?.network_index === index && index !== '0' && active.skill_id === request.skill.skill_id) return false
    const config = arenaSpConfig(c.tables, actor.config_id)
    const skill = config.skills.find(
        (skill) => skill.skill_id === request.skill.skill_id && [1, 2, 206].includes(skill.skill_slot),
    )
    if (!skill?.logic) return // Chained/passive skills do not use this recovery rule.
    advanceArenaSp(c)
    try {
        applyArenaCast(c, actor, skill, 'client', index)
    } catch (error) {
        if (error.arenaSpContext)
            Object.assign(error.arenaSpContext, {
                source_type: request.verify_info?.source_type,
                event_time: eventTime,
            })
        throw error
    }
    const current = c.state.combat.npcDuel
    if (index !== '0') {
        const receipts = { ...current.arena_cast_receipts }
        boundedSet(receipts, receiptKey, { skill_id: skill.skill_id }, 512)
        c.state.combat.npcDuel = { ...current, arena_cast_receipts: receipts }
    }
    if (skill.skill_slot === 206 && current.entry_reports?.[uuid]?.cast)
        c.state.combat.npcDuel = {
            ...c.state.combat.npcDuel,
            entry_reports: { ...current.entry_reports, [uuid]: { ...current.entry_reports[uuid], consumed: true } },
        }
    publishArenaSp(c)
}

export function recordArenaSkillStop(c, uuid, request) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel,
        active = run?.arena_casts?.[uuid]
    if (!active || String(active.skill_id) !== String(request.skill_id)) return
    const related = String(request.verify_info?.related_index ?? '0')
    if (related !== '0' && active.network_index !== '0' && active.network_index !== related) return
    c.state.combat.npcDuel = { ...run, arena_casts: { ...run.arena_casts, [uuid]: { ...active, ended: true } } }
}

export function recordArenaPropertyChange(c, request) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run?.actors[String(request.uuid)] || run.map_id !== c.state.world.map_id || run.result) return
    // Settle time under the previous modifiers; a new buff must not change
    // regeneration retroactively over the interval before its report.
    advanceArenaSp(c)
    mergeArenaProperties(c, request)
}

export function publishArenaSp(c, force = false) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id) return
    const sent = { ...run.pet_sp_sent },
        infos = []
    for (const actor of Object.values(run.actors)) {
        const entity = c.state.combat.entities[actor.uuid]
        if (!entity || (!force && entity.sp === (sent[actor.uuid] ?? 0))) continue
        // Include alive state: a partial SP packet must not revive a corpse
        // through SyncServerBaseData's absent-alive-state default0.
        infos.push({
            uuid: actor.uuid,
            hp: entity.hp,
            sp: entity.sp ?? 0,
            alive_state: entity.alive_state ?? 0,
            reason: 0,
            ...(entity.final_blow_guid ? { final_blow_guid: entity.final_blow_guid } : {}),
        })
        sent[actor.uuid] = entity.sp ?? 0
    }
    if (infos.length) (c.pushBefore ?? c.push)('CSProtoObjBattleInfoSync', { infos })
    c.state.combat.npcDuel = { ...run, pet_sp_sent: sent }
}
