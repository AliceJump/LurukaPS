import test from 'node:test'
import assert from 'node:assert/strict'
import { arenaDamageElement } from '../src/npc-kibo-damage-inputs.js'
import {
    arenaDamageAmounts,
    arenaNumericalConfig,
    arenaWeaknessRatio,
    arenaElementRestraint,
    arenaTrueDamageAmounts,
    arenaHealingAmounts,
    arenaHealingOverheal,
    arenaOutputFormulaId,
} from '../src/npc-kibo-damage-amounts.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'

const C = arenaNumericalConfig.constants
function fixture() {
    const source = new Map([
        [C.CRI_DMG, 1.5],
        [C.SKILL_SHOOTDMGUP, 0.5],
    ])
    const target = new Map([
        [C.DEF, 525],
        [C.SKILL_SUFFERDMGDOWN, 0.25],
    ])
    // Explicit neutral modifier values for this numerical fixture only.
    const input = {
        formula: 100,
        worldEventFactor: 1,
        criticalRandom: 9999,
        sourceLevel: 5,
        skillId: 5030012,
        skillTags: [C.SKT_PetNormalSkill],
        weaknessRatio: 1,
        levelPressure: 1,
        restraint: 0,
        inWeakState: false,
        fluentExit: false,
        useOneBreak: false,
        debugInvincible: false,
        targetHp: 1000,
        sourceProperty: (id) => source.get(id) ?? 0,
        targetProperty: (id) => target.get(id) ?? 0,
        resolveShield: (damage) => ({ damage, isShield: false }),
    }
    return { config: { ...arenaDamageElement(503001101) }, input, source, target }
}

test('native tag coefficients modify texFreeDamage separately from armor-reduced output damage', () => {
    const f = fixture(),
        result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 50)
    assert.equal(result.texFreeDamage, 175, '100 * (1 + .5 + .25), not a conventional received-damage subtraction')
    assert.equal(result.requestedHpDamage, 50)
    f.input.skillTags = [C.SKT_NormalSkill, C.SKT_PetNormalSkill, C.SKT_PetUltraSkill]
    assert.equal(
        arenaDamageAmounts(f.config, f.input).texFreeDamage,
        175,
        'three alternative normal-skill tags form one group',
    )
    f.input.skillTags = [C.SKT_NormalAttack, C.SKT_PetNormalSkill]
    f.source.set(C.ATTACK_SHOOTDMGUP, 0.5)
    assert.equal(arenaDamageAmounts(f.config, f.input).texFreeDamage, 262.5, 'different tag groups multiply')
})

test('critical chance is strict and piercing uses its pre-trigger value while crit damage is reread after the trigger', () => {
    const f = fixture()
    f.source.set(C.CRI, 1000)
    f.target.set(C.CRI_DEFENSE, 100)
    f.target.set(C.CRI_SUFFERDMGDOWN, 0.25)
    f.input.criticalRandom = 899
    let result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.isCritical, true)
    assert.equal(result.outputDamage, 62, '62.5 rounds to the even integer62')
    assert.equal(result.texFreeDamage, 218.75)
    f.input.criticalRandom = 900
    assert.equal(arenaDamageAmounts(f.config, f.input).isCritical, false)
    f.input.criticalRandom = 899
    f.target.set(C.CRI_SUFFERDMGDOWN, 0)
    let triggered = false
    f.input.sourceProperty = (id, normalized, phase) => {
        if (id === C.PERPIERCING) {
            assert.equal(phase, 'before-critical')
            assert.equal(triggered, false)
        }
        return f.source.get(id) ?? 0
    }
    f.input.beforeCritical = () => {
        triggered = true
        f.source.set(C.PERPIERCING, 1)
        f.source.set(C.CRI_DMG, 2)
    }
    result = arenaDamageAmounts(f.config, f.input)
    assert.equal(
        result.outputDamage,
        100,
        'the critical trigger cannot retroactively remove the earlier armor calculation input',
    )
    assert.equal(result.texFreeDamage, 350)
})

test('stack-overlimit uses mastery chance and coefficient while excluding ordinary crit and weakness multipliers', () => {
    const f = fixture()
    f.config.damageType = C.DamageType_StackOverLimit
    f.input.criticalRandom = 500
    f.input.masteryConstant = 1000
    f.input.weaknessRatio = NaN
    f.input.inWeakState = true
    f.source.set(C.CRI, 10000)
    f.source.set(C.MASTERY, 500)
    f.source.set(C.MASTERY_INC, 1000)
    f.target.set(C.WP_BREAK_DMGUP, 9)
    const result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.isCritical, false)
    assert.equal(result.isMasteryCritical, true)
    assert.equal(result.outputDamage, 150)
    assert.equal(result.texFreeDamage, 175)
})

test('elemental, common, restraint, miscellaneous, weak-state and fluent-exit stages retain native order', () => {
    const f = fixture()
    f.source.set(C.NORMAL_SHOOTDMGUP + f.config.damageElementalType, 0.5)
    f.target.set(C.NORMAL_DEFENSE + f.config.damageElementalType, 0.25)
    f.source.set(C.SHOOT_DMGUP, 0.5)
    f.target.set(C.SUFFER_DMGDOWN, 0.25)
    f.input.weaknessRatio = 2
    f.input.restraint = -0.25
    const settings = { ...arenaNumericalConfig, miscellaneous: 2 }
    assert.equal(arenaDamageAmounts(f.config, f.input, settings).outputDamage, 234)
    f.config.formula_id = 103
    assert.equal(
        arenaDamageAmounts(f.config, f.input, settings).outputDamage,
        117,
        'the actual blocked-formula list bypasses miscellaneous',
    )
    f.input.inWeakState = true
    f.target.set(C.WP_BREAK_DMGUP, 1)
    assert.equal(arenaDamageAmounts(f.config, f.input, settings).outputDamage, 234)
    f.input.fluentExit = true
    assert.equal(arenaDamageAmounts(f.config, f.input, settings).outputDamage, 0)
})

test('shield/minimum HP change output while mercy/debug change requested HP only, and early zero clears texFreeDamage', () => {
    const f = fixture()
    f.input.resolveShield = (damage) => ({ damage: damage - 20, isShield: true })
    let result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 30)
    assert.equal(result.texFreeDamage, 175)
    assert.equal(result.isShield, true)
    f.config.damageMinimunValueType = C.DamageMinimun_SpecialMinimunValue
    f.config.minimunHpValue = 1
    f.input.targetHp = 10
    assert.equal(arenaDamageAmounts(f.config, f.input).outputDamage, 9)
    f.config.damageMinimunValueType = 0
    f.config.mercy = true
    result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 30)
    assert.equal(result.requestedHpDamage, 9)
    f.input.debugInvincible = true
    assert.equal(arenaDamageAmounts(f.config, f.input).requestedHpDamage, 0)
    f.input.resolveShield = () => ({ damage: 0, isShield: true })
    result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.texFreeDamage, 0)
    assert.equal(result.isShield, false)
    assert.equal(result.earlyExit, true)
    f.input.useOneBreak = true
    result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 0)
    assert.equal(result.texFreeDamage, 175)
    assert.equal(result.isShield, true)
})

test('native float and even rounding boundaries differ from integer HP loss or double-only arithmetic', () => {
    const f = fixture()
    f.input.formula = 2.5
    f.input.skillId = 0
    f.input.skillTags = undefined
    f.target.set(C.DEF, 0)
    assert.equal(arenaDamageAmounts(f.config, f.input).outputDamage, 2)
    f.input.formula = 3.5
    assert.equal(arenaDamageAmounts(f.config, f.input).outputDamage, 4)
    f.input.formula = 16777217
    assert.equal(arenaDamageAmounts(f.config, f.input).texFreeDamage, 16777216)
    f.input.formula = 0
    f.input.worldEventFactor = 0.5
    const result = arenaDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 1)
    assert.equal(result.texFreeDamage, 0.5)
})

test('weakness assets and element restraint use actual configured tables and duel mode selection', () => {
    assert.equal(arenaWeaknessRatio(200172, 0), Math.fround(1.1))
    assert.equal(arenaWeaknessRatio(500020, 0), 1)
    assert.equal(arenaWeaknessRatio(200172, 999), 1)
    const tables = new Tables(configuration().tables)
    assert.equal(arenaElementRestraint(tables, 1, [5], true), Math.fround(0.33))
    assert.equal(arenaElementRestraint(tables, 1, [5], false), 0.25)
    assert.equal(arenaElementRestraint(tables, 1, [5, 6], true), 0)
    assert.equal(arenaElementRestraint(tables, 1, [5, 5], true), Math.fround(0.33))
})

test('other output branches and missing phases or shield services are never silently treated as ordinary unshielded damage', () => {
    const f = fixture()
    for (const type of [
        C.DamageType_Real,
        C.DamageType_Dummy,
        C.DamageType_Heal,
        C.DamageType_Weakness,
        C.DamageType_Shield,
    ])
        assert.throws(
            () => arenaDamageAmounts({ ...f.config, damageType: type }, f.input),
            /another native output branch/,
        )
    assert.throws(() => arenaDamageAmounts(f.config, { ...f.input, sourceProperty: undefined }), /source property/)
    assert.throws(() => arenaDamageAmounts(f.config, { ...f.input, fluentExit: undefined }), /fluent exit/)
    assert.throws(() => arenaDamageAmounts(f.config, { ...f.input, resolveShield: undefined }), /shield result/)
    assert.throws(() => arenaDamageAmounts(f.config, { ...f.input, formula: NaN }), /formula/)
    assert.equal(
        arenaDamageAmounts(f.config, { ...f.input, useOneBreak: undefined }).outputDamage,
        50,
        'the native nonzero-output branch does not read one-break state',
    )
})

test('real damage bypasses defense, crit and shields but retains world, weakness, miscellaneous and weak-state stages', () => {
    const f = fixture()
    f.config.damageType = C.DamageType_Real
    f.input.formula = 100
    f.input.worldEventFactor = 0.5
    f.input.weaknessRatio = 1.5
    f.input.sourceProperty = undefined
    f.input.resolveShield = undefined
    const settings = { ...arenaNumericalConfig, miscellaneous: 2 }
    let result = arenaTrueDamageAmounts(f.config, f.input, settings)
    assert.equal(result.outputDamage, 150)
    assert.equal(result.texFreeDamage, 0)
    assert.equal(result.requestedHpDamage, 150)
    f.input.inWeakState = true
    f.input.targetProperty = (id, normalized, phase) => {
        assert.equal(id, C.WP_BREAK_DMGUP)
        assert.equal(normalized, true)
        assert.equal(phase, 'snapshot-aware')
        return 1
    }
    assert.equal(arenaTrueDamageAmounts(f.config, f.input, settings).outputDamage, 300)
    f.config.formula_id = 103
    assert.equal(arenaTrueDamageAmounts(f.config, f.input, settings).outputDamage, 150)
})

test('real/dummy minimum HP, mercy and zero ordering preserve a positive reported dummy record without changing HP', () => {
    const f = fixture()
    f.config.damageType = C.DamageType_Real
    f.config.damageMinimunValueType = C.DamageMinimun_SpecialMinimunValue
    f.config.minimunHpValue = 1
    f.input.targetHp = 1
    f.input.useOneBreak = undefined
    let result = arenaTrueDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 0)
    assert.equal(result.earlyExit, false)
    f.config.damageMinimunValueType = 0
    f.config.mercy = true
    f.input.targetHp = 10.5
    result = arenaTrueDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 100)
    assert.equal(result.requestedHpDamage, 9.5)
    f.config.damageType = C.DamageType_Dummy
    result = arenaTrueDamageAmounts(f.config, f.input)
    assert.equal(result.outputDamage, 100)
    assert.equal(result.reportedDummyDamage, 9)
    assert.equal(result.requestedHpDamage, 0)
    const end = { ...f.config, formula_id: 2, real_formula_id: 103 }
    assert.equal(arenaOutputFormulaId(end), 103, 'native real-function lookup ignores the DOT end formula argument')
    f.config.damageType = C.DamageType_Real
    f.input.fluentExit = true
    f.input.useOneBreak = false
    assert.equal(arenaTrueDamageAmounts(f.config, f.input).earlyExit, true)
})

test('ordinary healing keeps full output separate from applied healing and adjusts overheal from the actual result', () => {
    const config = { damageType: C.DamageType_Heal, formula_id: 101 }
    const input = {
        elementTags: [],
        formula: 10,
        sourceProperty: () => 0.5,
        targetProperty: () => 0.25,
        targetHp: 90,
        targetMaxHp: 100,
    }
    const result = arenaHealingAmounts(config, input)
    assert.equal(result.outputDamage, 18)
    assert.equal(result.requestedHealAmount, 10)
    assert.equal(result.requestedHpDamage, -10)
    assert.equal(result.texFreeDamage, 0)
    assert.equal(result.overHealBeforeApplication, 8)
    assert.equal(arenaHealingOverheal(result, 10), 8)
    assert.equal(arenaHealingOverheal(result, 0), 18, 'locked/denied healing is not silently counted as applied')
    assert.throws(() => arenaHealingOverheal(result), /Actual healing result unavailable/)
    assert.throws(() => arenaHealingOverheal(result, 2147483648), /Actual healing result unavailable/)
})

test('system healing bypasses modifier reads while full or above-cap targets retain native overheal without HP loss', () => {
    const config = { damageType: C.DamageType_Heal, formula_id: 101 }
    const input = { elementTags: [C.ETag_System], formula: 10, targetHp: 100, targetMaxHp: 100 }
    let result = arenaHealingAmounts(config, input)
    assert.equal(result.outputDamage, 10)
    assert.equal(result.requestedHealAmount, 0)
    assert.equal(result.requestedHpDamage, 0)
    assert.equal(arenaHealingOverheal(result), 10)
    result = arenaHealingAmounts(config, { ...input, targetHp: 105 })
    assert.equal(result.healDeltaBeforeApplication, -5)
    assert.equal(result.requestedHpDamage, 0)
    assert.equal(arenaHealingOverheal(result), 15)
    result = arenaHealingAmounts(config, { ...input, targetHp: 99.75, formula: 1 })
    assert.equal(result.requestedHealAmount, 1)
    assert.equal(arenaHealingOverheal(result, 0), 1.75)
})

test('healing retains native even rounding/miscellaneous rules and validates only the branch it actually reads', () => {
    const config = { damageType: C.DamageType_Heal, formula_id: 101 }
    const input = { elementTags: [C.ETag_System], formula: 2.5, targetHp: 50, targetMaxHp: 100 }
    assert.equal(arenaHealingAmounts(config, input).outputDamage, 2)
    const settings = { ...arenaNumericalConfig, miscellaneous: 2 }
    assert.equal(arenaHealingAmounts(config, input, settings).outputDamage, 5)
    assert.equal(arenaHealingAmounts({ ...config, formula_id: 103 }, input, settings).outputDamage, 2)
    assert.throws(() => arenaHealingAmounts(config, { ...input, elementTags: [] }), /healing property/)
    assert.throws(() => arenaHealingAmounts(config, { ...input, targetMaxHp: undefined }), /maximum HP/)
    assert.throws(() => arenaTrueDamageAmounts(config, input), /real\/dummy/)
})
