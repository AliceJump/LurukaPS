import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { arenaContext, arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'
import { arenaElementPacket } from './npc-kibo-controls.js'

const { elements } = JSON.parse(
    fs.readFileSync(new URL('../configs/npc-arena-stage-buffs.json', import.meta.url), 'utf8'),
)
const schedules = new WeakMap()

export function arenaStageBuffSchedule(tables, duelId) {
    let cache = schedules.get(tables)
    if (!cache) schedules.set(tables, (cache = new Map()))
    if (!cache.has(duelId)) {
        const schedule = String(tables.find('kibo_duel', duelId).buffTime ?? '')
            .split('|')
            .filter(Boolean)
            .map((pair) => {
                const [at, id] = pair.split('#').map(Number)
                ensure(
                    Number.isFinite(at) && at >= 0 && elements[id],
                    'Arena stage buff configuration unavailable',
                    ErrorCode.GameConfig,
                )
                return { at, id }
            })
            .sort((a, b) => a.at - b.at)
        // Local element identity layout: account32, actor4, stage2, generation19,
        // namespace6. This is a local namespace, not an official UID format.
        ensure(
            schedule.length <= 4 && new Set(schedule.map((row) => row.id)).size === schedule.length,
            'Arena stage buff identity capacity exceeded',
            ErrorCode.GameConfig,
        )
        cache.set(duelId, schedule)
    }
    return cache.get(duelId)
}

const elapsed = (c) => {
    const run = c.state.combat?.npcDuel
    return run?.regular_started_at === undefined
        ? 0
        : Math.max(
              0,
              secondsToArenaMs(run.pause?.server_at ?? Math.min(c.now, run.end_at)) -
                  secondsToArenaMs(run.regular_started_at),
          )
}

export function arenaFeverInfo(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    const time = elapsed(c)
    const active =
        run && !run.result && run.map_id === c.state.world.map_id && c.state.multiCampaign?.arena_status === 4
    return {
        in_speed_stage:
            !!active && arenaStageBuffSchedule(c.tables, run.duel_id).some((row) => time >= secondsToArenaMs(row.at)),
        status_elapsed_time: String(time),
    }
}

export function publishArenaStageBuffs(c) {
    c = arenaContext(c)
    let run = c.state.combat?.npcDuel
    if (
        !run ||
        run.result ||
        run.map_id !== c.state.world.map_id ||
        c.state.multiCampaign?.arena_status !== 4 ||
        !run.entities_sent ||
        c.state.kiboDuelLoadingCompleteAt === undefined
    )
        return
    const stage = arenaFeverInfo(c)
    if (!stage.in_speed_stage) return
    const sent = {},
        entries = {},
        rows = []
    const account = BigInt(c.state.player.basic_info.id)
    for (const [index, segment] of arenaStageBuffSchedule(c.tables, run.duel_id).entries()) {
        if (elapsed(c) < secondsToArenaMs(segment.at)) continue
        for (const actor of Object.values(run.actors)) {
            if (!(c.state.combat.entities[actor.uuid]?.hp > 0)) continue
            const marker = `${index}:${actor.slot}`
            if (run.stage_buffs_sent?.[marker]) continue
            // All living roster entities already exist. Native kiBoApplyType1
            // pauses the effect in hand and resumes it on field entry.
            const uid = (
                (0x3fn << 57n) |
                (BigInt(run.generation) << 38n) |
                (BigInt(index) << 36n) |
                (BigInt(actor.slot - 1) << 32n) |
                account
            ).toString()
            const row = run.stage_buffs?.[uid] ?? {
                op: 10,
                uniqueId: uid,
                tar_id: actor.uuid,
                buff: {
                    cfg_id: segment.id,
                    layer: 1,
                    begin_time: String(secondsToArenaMs(run.regular_started_at + segment.at)),
                    attacker_id: actor.uuid,
                    executor_id: actor.uuid,
                    source_id: actor.uuid,
                    creator_id: actor.uuid,
                },
            }
            rows.push({
                ...row,
                verify_info: {
                    battle_index: '0',
                    related_index: '0',
                    source_type: 12,
                    source_id: '0',
                    op_time: String(arenaMillis(c)),
                },
            })
            entries[uid] = row
            sent[marker] = true
        }
    }
    if (!rows.length && run.fever_sent) return
    if (!run.fever_sent)
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: 4,
            status_endtime: String(Math.ceil(run.end_at)),
            enter_type: 0,
            ...stage,
        })
    if (rows.length) c.pushBefore('SCProtoBattleInfoReduceNtf', arenaElementPacket(rows))
    run = c.state.combat.npcDuel
    c.state.combat.npcDuel = {
        ...run,
        stage_buffs: { ...run.stage_buffs, ...entries },
        stage_buffs_sent: { ...run.stage_buffs_sent, ...sent },
        fever_sent: true,
    }
}

export function clearArenaStageBuffs(c) {
    const run = c.state.combat?.npcDuel
    if (!run?.stage_buffs) return
    const rows = Object.values(run.stage_buffs).map((row) => ({
        op: 2,
        uniqueId: row.uniqueId,
        tar_id: row.tar_id,
        buff: { executor_id: row.tar_id, attacker_id: row.tar_id },
    }))
    if (rows.length) c.pushBefore('SCProtoBattleInfoReduceNtf', arenaElementPacket(rows))
    // The native parent reset releases injected child elements. Drop echoed
    // parent/descendant receipts too; never overwrite unrelated elements.
    const removed = new Set(rows.map((row) => row.uniqueId)),
        existing = c.state.combat.elements ?? {}
    let changed
    do {
        changed = false
        for (const [id, row] of Object.entries(existing))
            if (!removed.has(id) && removed.has(row.parentUniqueId)) {
                removed.add(id)
                changed = true
            }
    } while (changed)
    c.state.combat.elements = Object.fromEntries(Object.entries(existing).filter(([id]) => !removed.has(id)))
    c.state.combat.npcDuel = { ...run, stage_buffs: {}, stage_buffs_sent: {}, fever_sent: false }
}
