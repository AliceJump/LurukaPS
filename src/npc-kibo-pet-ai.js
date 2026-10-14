import fs from 'node:fs'
import { arenaPetSkills } from './kibo-arena-attributes.js'
import { boundedSet } from './combat-state.js'

const { policies } = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-pet-ai.json', import.meta.url), 'utf8'))
const catalogs = new WeakMap()
const warnings = new Set()
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) / 100
const flags = (text) =>
    Object.fromEntries(
        String(text || '')
            .split('|')
            .filter(Boolean)
            .map((x) => x.split('#')),
    )

export function arenaPetAIProfile(tables, petId) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = { pets: new Map(), skills: new Map(tables.get('skillsub_logic').map((row) => [row.skillId, row])) }
        catalogs.set(tables, catalog)
    }
    if (catalog.pets.has(petId)) return catalog.pets.get(petId)
    const pet = tables.find('pet', petId),
        property = tables.find('unit_property', pet?.propertyId)
    const tree = tables.find('battle_behaviortree', property?.behavior),
        policy = policies[tree?.kiboArenaBehaviorTree]
    if (!policy) return null
    const bools = { ...flags(tree.paramBool), ...flags(property.paramBool) }
    const unit = tables.find('unit', pet.unitId)
    // The arena capsule uses unit.kibocollider: center xyz, radius, height.
    const capsule = unit?.kibocollider || tables.find('unit_collider', unit?.colliderId)?.colliderList
    const radius = Number(String(capsule || '').split(/[|#]/)[3])
    const [lockRange, loseRange] = String(pet.aimRange).split('|').map(Number)
    const skills = arenaPetSkills(tables, petId)
        .filter((skill) => policy.ordinary_slots.includes(skill.skill_slot))
        .map((skill) => {
            const logic = catalog.skills.get(skill.skill_id)
            if (
                !logic ||
                logic.conditionType !== 0 ||
                logic.spCost ||
                logic.skillValidityCondition ||
                !(logic.useDirection > 0)
            )
                return null
            return { ...skill, logic }
        })
        .filter(Boolean)
    if (!skills.length || !Number.isFinite(radius) || radius < 0 || !(lockRange > 0) || !(loseRange > 0)) return null
    const profile = {
        policy,
        skills,
        radius,
        lockRange,
        loseRange,
        engage: bools.IfEngage === '1',
        melee:
            !!policy.melee_surface_distance &&
            (bools.IfMelee === '1' || tree.kiboArenaBehaviorTree.endsWith('_short.asset')),
    }
    catalog.pets.set(petId, profile)
    return profile
}

export function stopArenaPetAI(c) {
    const run = c.state.combat?.npcDuel
    if (!run?.pet_ai) return
    const petAI = { ...run.pet_ai }
    for (const [uuid, ai] of Object.entries(petAI)) {
        if (ai.moving && run.in_fight[uuid]) c.pushBefore('SCProtoKiboStopMove', { uuid })
        petAI[uuid] = { ...ai, moving: false }
    }
    c.state.combat.npcDuel = { ...run, pet_ai: petAI }
}

// CBT3 Macro.KIBO_VERSUS_AI_RUN_SERVICE defaults to true. In arena type5
// neither camp has a local decision tree.11706/11707 execute path actions;
//11101 executes a skill via SkillNetwork, with actual client hit reports
// continuing through BattleInfoReduce. Never simulate a kill to advance AI.
export function advanceArenaPetAI(c) {
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id || c.state.multiCampaign?.arena_status !== 4 || run.result) return
    if (run.ai_control?.[0] === 1 || run.ai_control?.[2] === 1) {
        stopArenaPetAI(c)
        return
    }
    const now = c.now * 1000,
        petAI = { ...run.pet_ai }
    const active = Object.keys(run.in_fight)
        .map((uuid) => run.actors[uuid])
        .filter((actor) => battle.entities[actor.uuid]?.hp > 0)
    const position = (actor) => run.in_fight[actor.uuid].move.pos
    for (const actor of active) {
        const profile = arenaPetAIProfile(c.tables, actor.config_id)
        if (!profile) {
            if (!warnings.has(actor.config_id)) {
                warnings.add(actor.config_id)
                console.warn(`[npc-arena] Pet AI configuration unavailable: pet ${actor.config_id}`)
            }
            continue
        }
        const previous = petAI[actor.uuid] ?? {
            cooldowns: {},
            groups: {},
            gcd_until: 0,
            cast_index: 0,
            // Entry movie must not consume a pet's initial combat cooldown.
            ready_at:
                Math.max(
                    run.regular_started_at ?? c.now,
                    run.in_fight[actor.uuid].entered_at ?? run.regular_started_at ?? c.now,
                ) * 1000,
        }
        const ai = { ...previous, cooldowns: { ...previous.cooldowns }, groups: { ...previous.groups } }
        const enemies = active.filter((other) => other.camp !== actor.camp)
        let target = enemies.find(
            (other) =>
                ai.locked &&
                other.uuid === ai.target &&
                distance(position(actor), position(other)) <= profile.loseRange,
        )
        if (!target)
            target = enemies
                .filter((other) => distance(position(actor), position(other)) <= profile.lockRange)
                .sort(
                    (a, b) =>
                        distance(position(actor), position(a)) - distance(position(actor), position(b)) ||
                        a.slot - b.slot,
                )[0]
        const locked = !!target
        // KiBoLockTarget replaces the graph's10/15 defaults with pet.aimRange.
        // When no target is in range, KiboMove.nearstEnemyPos approaches the
        // nearest live enemy instead of idling outside acquisition range.
        if (!target)
            target = enemies.sort(
                (a, b) =>
                    distance(position(actor), position(a)) - distance(position(actor), position(b)) || a.slot - b.slot,
            )[0]
        if (!target) {
            if (ai.moving) c.pushBefore('SCProtoKiboStopMove', { uuid: actor.uuid })
            petAI[actor.uuid] = { ...ai, moving: false, locked: false, target: undefined }
            continue
        }
        const candidates = profile.skills.filter(
            ({ skill_id, logic }) =>
                now >= (ai.cooldowns[skill_id] ?? ai.ready_at + logic.kiBoCoolDownDefault) &&
                now >= (ai.groups[`self:${logic.selfCDGroup}`] ?? 0) &&
                now >= (ai.groups[`public:${logic.publicCDGroup}`] ?? 0),
        )
        const priority = Math.max(...candidates.map((skill) => skill.logic.castPriority))
        const preferred = candidates.filter((skill) => skill.logic.castPriority === priority)
        // Current ordinary slot weights are integral; use the client's
        // priority-then-weight intent without selecting an unavailable slot.
        let selected = preferred[0]
        if (preferred.length > 1) {
            const total = preferred.reduce((sum, skill) => sum + Math.max(0, skill.logic.castPriorityWeight), 0)
            let pick = total > 0 ? c.randomInt(0, Math.ceil(total * 1000)) / 1000 : 0
            selected =
                preferred.find((skill) => (pick -= Math.max(0, skill.logic.castPriorityWeight)) < 0) ?? preferred.at(-1)
        }
        const targetProfile = arenaPetAIProfile(c.tables, target.config_id)
        const attackRange = profile.melee
            ? profile.policy.melee_surface_distance + profile.radius + (targetProfile?.radius ?? 0)
            : (selected ?? profile.skills[0]).logic.useDirection + profile.radius + (targetProfile?.radius ?? 0)
        const range = locked ? attackRange : Math.min(attackRange, profile.lockRange)
        const gap = distance(position(actor), position(target))
        const moveAction = !locked && profile.engage ? 1 : 0
        if (gap > range) {
            if (!ai.moving || ai.target !== target.uuid || ai.move_range !== range || ai.move_action !== moveAction) {
                c.pushBefore('SCProtoKiboStartMove', {
                    uuid: actor.uuid,
                    target: position(target),
                    target_uuid: target.uuid,
                    precision: range,
                    move_action_type: moveAction,
                    angular_velocity: profile.policy.angular_velocity,
                    dir_change_slerp_time: profile.policy.dir_change_slerp_time,
                })
                ai.moving = true
                ai.move_range = range
                ai.move_action = moveAction
            }
        } else {
            if (ai.moving) c.pushBefore('SCProtoKiboStopMove', { uuid: actor.uuid })
            ai.moving = false
            if (locked && selected && now >= ai.gcd_until) {
                const pos = position(actor),
                    targetPos = position(target),
                    logic = selected.logic
                ai.cast_index++
                const skill = {
                    skill_id: selected.skill_id,
                    slot: selected.skill_slot,
                    angle: Math.round(
                        (((Math.atan2(targetPos.x - pos.x, targetPos.z - pos.z) * 180) / Math.PI + 360) % 360) * 100,
                    ),
                    posx: pos.x,
                    posy: pos.y,
                    posz: pos.z,
                    lock_id: target.uuid,
                    begin_time: String(now),
                    cd_time_p: String(now + logic.kiBoVersusCoolDown),
                    // SkillInfo.index is the skill's subskill/animation index,
                    // not the cast sequence counter. Ordinary casts begin at0.
                    index: 0,
                    segment: 0,
                    self_cd: String(logic.selfCD),
                    public_cd: String(logic.publicCD),
                    gcd: String(logic.GCD),
                }
                c.pushBefore('SCProtoSkillStartSync', { unit_id: actor.uuid, skill, op_time: String(now) })
                battle.skills = { ...battle.skills }
                boundedSet(
                    battle.skills,
                    actor.uuid,
                    { unit_id: actor.uuid, skill, op_time: String(now), updated_at: c.now },
                    256,
                )
                ai.cooldowns[selected.skill_id] = now + logic.kiBoVersusCoolDown
                if (logic.selfCDGroup) ai.groups[`self:${logic.selfCDGroup}`] = now + logic.selfCD
                if (logic.publicCDGroup) ai.groups[`public:${logic.publicCDGroup}`] = now + logic.publicCD
                ai.gcd_until = now + logic.GCD
            }
        }
        ai.target = target.uuid
        ai.locked = locked
        petAI[actor.uuid] = ai
    }
    // Discard actions for dead/returned cards; retain their skill cooldowns
    // so returning a living card cannot reset its attack cooldown.
    for (const uuid of Object.keys(petAI))
        if (!run.in_fight[uuid]) petAI[uuid] = { ...petAI[uuid], moving: false, target: undefined }
    battle.npcDuel = { ...run, pet_ai: petAI }
}
