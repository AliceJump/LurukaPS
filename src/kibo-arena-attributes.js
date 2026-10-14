import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'

export function arenaPetSkills(tables, petId) {
    const pet = tables.find('pet', petId)
    ensure(pet, 'Arena pet configuration unavailable', 1007)
    const skills = new Map()
    for (const field of ['fixedSkillList', 'kiboBPropertyskillList', 'kiboSkillList'])
        for (const token of String(pet[field] || '')
            .split('|')
            .filter(Boolean)) {
            const [slot, id, level = 1] = token.split('#').map(Number)
            ensure(Number.isInteger(slot) && id > 0 && level > 0, 'Invalid arena skill configuration', 1007)
            skills.set(slot, { skill_slot: slot, skill_id: id, skill_lv: level, type: 1 })
        }
    // These are skill IDs, not pet_dna IDs. Keep them as passive skills.
    return [
        ...skills.values(),
        ...String(pet.kiboDnaList || '')
            .split('|')
            .filter(Boolean)
            .map((id) => ({ skill_slot: 0, skill_id: Number(id), skill_lv: 1, type: 0 })),
    ]
}

export function arenaPetAttributes(tables, petId, level) {
    const pet = tables.find('pet', petId)
    const growId = Number(tables.get('game').find((row) => row.title === 'PETGROW_ID')?.value)
    const base = tables.find('template_value', pet?.kiboArenaBaseTemplateID || pet?.propertyId)
    const growth = tables.find('template_value', growId + 1000 + level)
    ensure(Number.isInteger(level) && level > 0 && base && growth, 'Arena pet attribute template unavailable', 1007)
    const skills = arenaPetSkills(tables, petId),
        values = pairs(base.baseAttribute)
    // DataPropertyUtility.GetSimulatorAttribute/AddSkillBaseAttrConfig.
    for (const skill of skills) {
        if (tables.find('skill', skill.skill_id)?.skillType !== 2) continue
        for (const [id, value] of pairs(tables.find('skillsub_attrup', skill.skill_id)?.attributeList))
            values.set(id, Math.fround((values.get(id) ?? 0) + value))
    }
    const attributes = new Map()
    for (const [id, factor] of pairs(growth.baseAttribute))
        attributes.set(id, Math.fround(Math.fround(factor) * Math.fround(values.get(id) ?? 1)))
    for (const [id, value] of pairs(pet.kiboBaseAttribute)) attributes.set(id, value)
    // The client explicitly resets these four attributes in the arena builder.
    for (const id of [110, 226, 227, 105]) attributes.set(id, 0)
    // Keep wire fixed-point units: the receiving client performs its normal
    // SpecialAttList conversion. Do not apply old-mode KIBO_DUEL_TEMPLATE_*.
    const attrs = {
        attrs: [...attributes]
            .sort((a, b) => a[0] - b[0])
            .map(([attr_id, value]) => {
                ensure(Number.isSafeInteger(Math.trunc(value)), 'Arena attribute exceeds numeric range', 1007)
                return { attr_id, attr_val: String(Math.trunc(value)) }
            }),
    }
    const hp = Math.floor((attributes.get(5) ?? 0) / 10000)
    ensure(hp > 0 && hp <= 0xffffffff, 'Invalid arena pet HP', 1007)
    return {
        attrs,
        skills: [{ module_type: 4, sub_modules: [{ sub_module_id: 0, attrs: { attrs: [] }, skills: { skills } }] }],
        hp,
    }
}
