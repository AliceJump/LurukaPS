import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { maximumLevel, advanceLevel } from './handlers/progression.js'

export function grantDuelAreaExperience(tables, state, currencyId, amount) {
    const area = tables.get('kibo_duel_area_type').find((row) => row.currencyId === currencyId)
    if (!area) return false
    const levels = tables
        .get('kibo_duel_area_level')
        .filter((row) => row.areaType === area.Id)
        .sort((a, b) => a.level - b.level)
    ensure(
        levels.length && Number.isSafeInteger(amount) && amount > 0,
        'Invalid duel area experience',
        ErrorCode.GameConfig,
    )
    const areas = (state.kiboDuelAreas ??= {})
    const info = (areas[area.Id] ??= { id: area.Id, lvl: 1, exp: 0, got_lvl_reward: [1] })
    info.exp += amount
    ensure(Number.isSafeInteger(info.exp) && info.exp <= 0xffffffff, 'Duel area experience overflow')
    while (info.lvl < levels.at(-1).level) {
        const level = levels.find((row) => row.level === info.lvl)
        ensure(level?.exp > 0, 'Duel area level curve unavailable', ErrorCode.GameConfig)
        if (info.exp < level.exp) break
        info.exp -= level.exp
        info.lvl++
    }
    const attrs = state.player.attr_infos.attrs
    let attr = attrs.find((row) => row.attr_id === currencyId)
    if (!attr) attrs.push((attr = { attr_id: currencyId }))
    attr.attr_val = String(info.exp)
    return true
}

export function grantDuelPetExperience(tables, state, guids, amount) {
    const rows = tables.get('pet_level'),
        cap = maximumLevel(rows, state.player.basic_info.lv),
        infos = []
    for (const guid of new Set(guids.map(String))) {
        const pet = state.pets.find((entry) => entry.guid === guid)
        if (!pet) continue // Trial pets are not permanent inventory pets.
        const before = { pet_guid: pet.guid, old_lv: pet.lv, old_exp: pet.exp ?? 0 }
        if (pet.lv < cap) {
            const result = advanceLevel(rows, pet.lv, pet.exp ?? 0, amount, cap)
            pet.lv = result.level
            pet.exp = result.exp
        } else {
            pet.exp = (pet.exp ?? 0) + amount
            ensure(Number.isSafeInteger(pet.exp) && pet.exp <= 0xffffffff, 'Pet experience overflow')
        }
        infos.push({ ...before, now_lv: pet.lv, now_exp: pet.exp })
    }
    if (infos.length) state.petRevision = (state.petRevision ?? 0) + 1
    return infos
}

export function duelProgressSnapshot(tables, state) {
    const area_infos = tables
        .get('kibo_duel_area_type')
        .map((area) => state.kiboDuelAreas?.[area.Id] ?? { id: area.Id, lvl: 1, exp: 0, got_lvl_reward: [1] })
    const unlocked = new Set()
    for (const info of area_infos)
        for (const row of tables
            .get('kibo_duel_area_level')
            .filter((row) => row.areaType === info.id && row.level <= info.lvl))
            for (const id of String(row.kiboDuelSkill || '')
                .split('|')
                .filter(Boolean)) {
                const skill = tables.find('kibo_duel_skill', Number(id))
                if (skill?.skillId) unlocked.add(skill.skillId)
            }
    return { area_infos, unlock_skills: [...unlocked] }
}
