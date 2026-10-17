import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'

export const arenaNumericalConfig = Object.freeze(
    JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-numerical.json', import.meta.url), 'utf8')),
)
const F = Math.fround
const add = (a, b) => F(F(a) + F(b)),
    sub = (a, b) => F(F(a) - F(b))
const mul = (a, b) => F(F(a) * F(b)),
    div = (a, b) => F(F(a) / F(b))
const finite = (value, name) => {
    ensure(Number.isFinite(value), `Arena damage input unavailable: ${name}`, ErrorCode.GameConfig)
    return F(value)
}
const boolean = (value, name) => {
    ensure(typeof value === 'boolean', `Arena damage input unavailable: ${name}`, ErrorCode.GameConfig)
    return value
}
const roundEven = (value) => {
    const floor = Math.floor(value),
        fraction = value - floor
    return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}

export function arenaWeaknessRatio(unit, collision, settings = arenaNumericalConfig) {
    const row = settings.weakness_units.find((row) => row.unitId === unit)
    const read = (row) => {
        const index = row?.collisionTypes.indexOf(collision) ?? -1
        return index < 0 ? undefined : row.weaknessRatios[index]
    }
    return finite(read(row) ?? read(settings.weakness_default) ?? 1, 'weakness ratio')
}

export function arenaElementRestraint(tables, element, targetElements, inDuel) {
    ensure(
        Array.isArray(targetElements) && typeof inDuel === 'boolean',
        'Arena target elemental state unavailable',
        ErrorCode.GameConfig,
    )
    const row = tables.find('element_type', element)
    if (!row) return 0 // Native provider returns0 when the element table row is absent.
    let result = F(0)
    for (const entry of String(inDuel ? row.kiboRestraint : row.restraint)
        .split('|')
        .filter(Boolean)) {
        const [type, amount] = entry.split('#').map(Number)
        if (targetElements.includes(type)) result = add(result, div(amount, 10000))
    }
    return result
}

export function arenaOutputFormulaId(config, settings = arenaNumericalConfig) {
    const C = settings.constants
    // GetOutputRealDamage calls GetRealFunctionId on the config, ignoring the
    // end-damage formula argument while keeping the current parameter vector.
    return [C.DamageType_Real, C.DamageType_Dummy].includes(config.damageType)
        ? (config.real_formula_id ?? config.formula_id)
        : config.formula_id
}

export function arenaTrueDamageAmounts(config, input, settings = arenaNumericalConfig) {
    const C = settings.constants
    ensure(
        [C.DamageType_Real, C.DamageType_Dummy].includes(config.damageType),
        'Not a native real/dummy damage branch',
        ErrorCode.GameConfig,
    )
    const number = (name) => finite(input[name], name)
    let amount = mul(mul(Math.max(number('formula'), 1), number('worldEventFactor')), number('weaknessRatio'))
    if (!settings.blocked_miscellaneous_formulas.includes(arenaOutputFormulaId(config, settings)))
        amount = mul(amount, settings.miscellaneous)
    if (boolean(input.inWeakState, 'weak state'))
        amount = mul(
            amount,
            add(
                1,
                finite(input.targetProperty?.(C.WP_BREAK_DMGUP, true, 'snapshot-aware'), 'target weak-state property'),
            ),
        )
    if (boolean(input.fluentExit, 'fluent exit')) amount = 0
    // This branch tests zero before the minimum-HP clamp, unlike ordinary damage.
    if (amount === 0 && !boolean(input.useOneBreak, 'one-break state'))
        return {
            outputDamage: 0,
            texFreeDamage: 0,
            requestedHpDamage: 0,
            isCritical: false,
            isShield: false,
            earlyExit: true,
        }
    if (config.damageMinimunValueType === C.DamageMinimun_SpecialMinimunValue) {
        const remaining = sub(number('targetHp'), finite(config.minimunHpValue, 'minimum HP'))
        amount = remaining < 0 ? 0 : F(Math.min(amount, remaining))
    }
    const rounded = roundEven(amount)
    ensure(
        Number.isInteger(rounded) && rounded >= -2147483648 && rounded <= 2147483647,
        'Arena output exceeds int32',
        ErrorCode.GameConfig,
    )
    amount = F(rounded)
    let request = boolean(input.debugInvincible, 'debug invincibility') ? 0 : amount
    if (config.mercy) request = F(Math.min(request, Math.abs(sub(number('targetHp'), 1))))
    const dummy = config.damageType === C.DamageType_Dummy
    return {
        outputDamage: amount,
        texFreeDamage: 0,
        requestedHpDamage: dummy ? 0 : request,
        ...(dummy ? { reportedDummyDamage: Math.trunc(request) } : {}),
        isCritical: false,
        isShield: false,
        earlyExit: false,
    }
}

export function arenaHealingAmounts(config, input, settings = arenaNumericalConfig) {
    const C = settings.constants
    ensure(config.damageType === C.DamageType_Heal, 'Not a native healing branch', ErrorCode.GameConfig)
    ensure(
        input.elementTags === null || Array.isArray(input.elementTags),
        'Arena element tags unavailable',
        ErrorCode.GameConfig,
    )
    let amount = F(Math.max(finite(input.formula, 'formula'), 1))
    if (!input.elementTags?.includes(C.ETag_System)) {
        const source = finite(input.sourceProperty?.(C.SHOOT_HEALUP, true, 'snapshot-aware'), 'source healing property')
        const target = finite(
            input.targetProperty?.(C.SUFFER_HEALUP, true, 'snapshot-aware'),
            'target healing property',
        )
        amount = mul(amount, add(add(1, source), target))
    }
    if (!settings.blocked_miscellaneous_formulas.includes(config.formula_id))
        amount = mul(amount, settings.miscellaneous)
    const rounded = roundEven(amount)
    ensure(
        Number.isInteger(rounded) && rounded >= -2147483648 && rounded <= 2147483647,
        'Arena heal exceeds int32',
        ErrorCode.GameConfig,
    )
    amount = F(rounded)
    const hp = finite(input.targetHp, 'target HP'),
        max = finite(input.targetMaxHp, 'target maximum HP')
    const potential = add(hp, amount)
    let delta, overflow
    if (potential >= max && hp < max) {
        overflow = sub(potential, max)
        delta = F(Math.max(1, sub(max, hp)))
    } else if (potential >= max) {
        overflow = sub(potential, max)
        delta = sub(max, hp)
    } else {
        delta = sub(potential, hp)
        overflow = 0
    }
    const requested = delta > 0 ? delta : 0
    return {
        outputDamage: amount,
        texFreeDamage: 0,
        requestedHpDamage: requested > 0 ? -requested : 0,
        requestedHealAmount: requested,
        healDeltaBeforeApplication: delta,
        overHealBeforeApplication: overflow,
        isCritical: false,
        isShield: false,
    }
}

export function arenaHealingOverheal(result, actualHeal) {
    let overflow = finite(result.overHealBeforeApplication, 'pre-application overheal')
    if (result.healDeltaBeforeApplication > 0) {
        ensure(
            Number.isInteger(actualHeal) && actualHeal >= -2147483648 && actualHeal <= 2147483647,
            'Actual healing result unavailable',
            ErrorCode.GameConfig,
        )
        overflow = add(overflow, sub(result.healDeltaBeforeApplication, finite(actualHeal, 'actual heal')))
    }
    return overflow >= 0 ? overflow : null // Native SetOverHeal is skipped when negative.
}

// Numeric stages of framework.GetOutputDamage. The caller must supply actual
// property phases, target flags and shield resolution. This neither executes
// buff/weak-point graphs nor changes HP, and must not assume missing inputs.
export function arenaDamageAmounts(config, input, settings = arenaNumericalConfig) {
    const C = settings.constants,
        type = config.damageType
    ensure(
        ![
            C.DamageType_Real,
            C.DamageType_Dummy,
            C.DamageType_Heal,
            C.DamageType_Weakness,
            C.DamageType_Shield,
        ].includes(type),
        'Arena damage requires another native output branch',
        ErrorCode.GameConfig,
    )
    const source = (id, normalized = false, phase = 'after-critical') =>
        finite(input.sourceProperty?.(id, normalized, phase), `source property ${id}`)
    const target = (id, normalized = false, phase = 'after-critical') =>
        finite(input.targetProperty?.(id, normalized, phase), `target property ${id}`)
    const number = (name) => finite(input[name], name)
    // The native percentage-piercing lookup precedes formula/critical events.
    let percentagePiercing = div(finite(config.armerPenetration, 'configured armor penetration'), 10000)
    if (percentagePiercing < 0) percentagePiercing = source(C.PERPIERCING, true, 'before-critical')
    const raw = mul(Math.max(number('formula'), 1), number('worldEventFactor'))
    let criticalDamage = source(C.CRI_DMG, true, 'before-critical')
    let criticalReduction = target(C.CRI_SUFFERDMGDOWN, true, 'before-critical')
    const chance = source(C.CRI, false, 'before-critical'),
        defenseChance = target(C.CRI_DEFENSE, false, 'before-critical')
    const random = number('criticalRandom')
    ensure(Number.isInteger(random) && random >= 0 && random < 10000, 'Invalid arena critical roll')
    let isCritical = random < sub(chance, defenseChance) && type !== C.DamageType_StackOverLimit
    let criticalMultiplier = F(1)
    if (isCritical) {
        input.beforeCritical?.()
        criticalReduction = target(C.CRI_SUFFERDMGDOWN, true)
        criticalDamage = source(C.CRI_DMG, true)
        criticalMultiplier = F(Math.max(1, sub(criticalDamage, criticalReduction)))
    }

    const skill = number('skillId'),
        tags = input.skillTags
    ensure(skill <= 0 || tags === null || Array.isArray(tags), 'Arena skill tags unavailable', ErrorCode.GameConfig)
    let skillMultiplier = F(1)
    if (skill > 0 && tags) {
        const groups = [
            [[C.SKT_NormalAttack], C.ATTACK_SHOOTDMGUP, C.ATTACK_SUFFERDMGDOWN],
            [[C.SKT_WhackAttack], C.CHARGEDATTACK_SHOOTDMGUP, C.CHARGEDATTACK_SUFFERDMGDOWN],
            [[C.SKT_NormalSkill, C.SKT_PetNormalSkill, C.SKT_PetUltraSkill], C.SKILL_SHOOTDMGUP, C.SKILL_SUFFERDMGDOWN],
            [[C.SKT_AerialAttack], C.AERIALATTACK_SHOOTDMGUP, C.AERIALATTACK_SUFFERDMGDOWN],
            [[C.SKT_UltraSkill], C.ULTRAATTACK_SHOOTDMGUP, C.ULTRAATTACK_SUFFERDMGDOWN],
        ]
        for (const [matches, up, down] of groups)
            if (matches.some((tag) => tags.includes(tag)))
                skillMultiplier = mul(skillMultiplier, add(add(1, source(up, true)), target(down, true)))
    }

    const flatPiercing = source(C.PIERCING),
        targetDefense = target(C.DEF)
    const defense = F(Math.max(mul(sub(targetDefense, flatPiercing), sub(1, percentagePiercing)), 0))
    const level = number('sourceLevel'),
        levelCoefficient = F(level * 5 + 500)
    const armored = mul(raw, div(levelCoefficient, add(levelCoefficient, defense)))
    const element = finite(config.damageElementalType, 'damage element'),
        factor = div(finite(config.elementCalFactor, 'element factor'), 10000)
    const elementalUp = mul(factor, source(C.NORMAL_SHOOTDMGUP + element, true))
    const elementalDown = mul(target(C.NORMAL_DEFENSE + element, true), factor)
    const elementMultiplier = F(Math.max(sub(add(1, elementalUp), elementalDown), 0))
    const damageMultiplier = F(Math.max(sub(add(1, source(C.SHOOT_DMGUP, true)), target(C.SUFFER_DMGDOWN, true)), 0))
    let amount,
        isMasteryCritical = false
    if (type === C.DamageType_StackOverLimit) {
        const mastery = source(C.MASTERY),
            masteryConstant = number('masteryConstant')
        ensure(masteryConstant > 0, 'Arena mastery denominator unavailable', ErrorCode.GameConfig)
        isMasteryCritical = random < source(C.MASTERY_INC)
        amount = mul(armored, isMasteryCritical ? 2 : 1)
        amount = mul(mul(amount, elementMultiplier), damageMultiplier)
        amount = mul(amount, Math.max(add(1, div(mastery, masteryConstant)), 1))
        amount = mul(amount, number('levelPressure'))
    } else {
        amount = mul(mul(armored, elementMultiplier), damageMultiplier)
        amount = mul(mul(mul(amount, number('weaknessRatio')), criticalMultiplier), number('levelPressure'))
    }
    amount = F(Math.max(mul(amount, add(1, number('restraint'))), 1))
    if (!settings.blocked_miscellaneous_formulas.includes(config.formula_id))
        amount = mul(amount, settings.miscellaneous)
    if (boolean(input.inWeakState, 'weak state') && type !== C.DamageType_StackOverLimit)
        amount = mul(amount, add(1, target(C.WP_BREAK_DMGUP, true)))
    if (boolean(input.fluentExit, 'fluent exit')) amount = F(0)
    const rounded = roundEven(amount)
    ensure(
        Number.isInteger(rounded) && rounded >= -2147483648 && rounded <= 2147483647,
        'Arena output exceeds int32',
        ErrorCode.GameConfig,
    )
    const shield = input.resolveShield?.(rounded)
    ensure(
        shield &&
            Number.isInteger(shield.damage) &&
            shield.damage >= -2147483648 &&
            shield.damage <= 2147483647 &&
            typeof shield.isShield === 'boolean',
        'Arena shield result unavailable',
        ErrorCode.GameConfig,
    )
    let output = shield.damage
    if (config.damageMinimunValueType === C.DamageMinimun_SpecialMinimunValue) {
        const remaining = Math.trunc(number('targetHp')) - Math.trunc(finite(config.minimunHpValue, 'minimum HP'))
        output = remaining < 0 ? 0 : Math.min(output, remaining)
    }
    // Native zero-output early return leaves texFreeDamage/isShield at default0.
    if (output === 0 && !boolean(input.useOneBreak, 'one-break state'))
        return {
            outputDamage: 0,
            texFreeDamage: 0,
            requestedHpDamage: 0,
            isCritical,
            isMasteryCritical,
            isShield: false,
            earlyExit: true,
        }
    let hpDamage = boolean(input.debugInvincible, 'debug invincibility') ? 0 : F(output)
    if (config.mercy) hpDamage = F(Math.min(hpDamage, Math.abs(Math.trunc(number('targetHp')) - 1)))
    return {
        outputDamage: F(output),
        texFreeDamage: mul(mul(raw, criticalMultiplier), skillMultiplier),
        requestedHpDamage: hpDamage,
        isCritical,
        isMasteryCritical,
        isShield: shield.isShield,
        earlyExit: false,
    }
}
