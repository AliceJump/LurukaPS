import { ensure } from './handlers/common.js'
const MAX_U64 = (1n << 64n) - 1n
export function u64(value) {
    const s = String(value ?? '0')
    ensure(/^\d+$/.test(s) && BigInt(s) <= MAX_U64, 'Invalid uint64')
    return BigInt(s).toString()
}
// BattleVerifyInfo.source_id is int64, unlike its unsigned sequence IDs.
export function i64(value) {
    const s = String(value ?? '0')
    ensure(
        /^-?\d+$/.test(s) &&
            (typeof value !== 'number' || Number.isSafeInteger(value)) &&
            BigInt(s) >= -(1n << 63n) &&
            BigInt(s) < 1n << 63n,
        'Invalid int64',
    )
    return BigInt(s).toString()
}
// Request-side inverse of CBT3 BattleService.Add*/SendBattleInfoDatas.
export function expandBattleReport(request) {
    const dictionary = request.uint64_dic ?? [],
        rows = request.battle_info ?? []
    ensure(dictionary.length <= 4096 && rows.length <= 1024, 'Battle report exceeds limits')
    const ids = dictionary.map(u64),
        base = BigInt(u64(request.base_time))
    const lookup = (value, small = false) => {
        const index = BigInt(u64(value))
        ensure(index <= BigInt(ids.length), 'Battle dictionary index outside packet')
        const id = index === 0n ? '0' : ids[Number(index) - 1]
        return small ? Number(BigInt(id) & 0xffffffffn) : id
    }
    const verify = (v) => {
        if (!v) return
        if (v.related_index !== undefined) v.related_index = lookup(v.related_index)
        v.op_time = BigInt.asUintN(64, base - BigInt(u64(v.op_time))).toString()
    }
    return rows.map((raw) => {
        const row = structuredClone(raw)
        ensure(
            [row.hurt_info, row.element_info, row.attr_change].filter(Boolean).length === 1,
            'Battle row must contain exactly one event',
        )
        if (row.hurt_info) {
            const h = row.hurt_info
            h.from_id = lookup(h.from_id)
            h.tar_id = lookup(h.tar_id)
            if (h.skill_id !== undefined) h.skill_id = lookup(h.skill_id, true)
            if (h.element_uniqueId !== undefined) h.element_uniqueId = lookup(h.element_uniqueId)
            verify(h.verify_info)
        }
        if (row.element_info) {
            const e = row.element_info
            e.tar_id = lookup(e.tar_id)
            e.uniqueId = lookup(e.uniqueId)
            if (e.parentUniqueId !== undefined) e.parentUniqueId = lookup(e.parentUniqueId)
            verify(e.verify_info)
            const b = e.buff
            if (b) {
                for (const k of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
                    if (b[k] !== undefined) b[k] = lookup(b[k])
                if ([1, 7, 10].includes(e.op) && b.cfg_id !== undefined) b.cfg_id = lookup(b.cfg_id, true)
                if ([1, 7].includes(e.op))
                    b.begin_time = BigInt.asUintN(64, base - BigInt(u64(b.begin_time))).toString()
                for (const entry of b.entrys ?? [])
                    if ([3, 4].includes(entry.key))
                        entry.ui64_dic_values = (entry.ui64_dic_values ?? []).map((x) => lookup(x))
            }
        }
        // AddAttrChangeInfo does not dictionary-compress uuid or values.
        if (row.attr_change) row.attr_change.uuid = u64(row.attr_change.uuid)
        return row
    })
}
export function combatState(state, now) {
    if (!state.combat || state.combat.map_id !== state.world.map_id)
        state.combat = {
            map_id: state.world.map_id,
            skills: {},
            bullets: {},
            elements: {},
            entities: {},
            report_count: 0,
        }
    const battle = state.combat
    for (const [id, b] of Object.entries(battle.bullets)) if (now - b.updated_at > 120) delete battle.bullets[id]
    return battle
}
export function boundedSet(map, id, value, limit) {
    if (!Object.hasOwn(map, id) && Object.keys(map).length >= limit) delete map[Object.keys(map)[0]]
    map[id] = value
}
