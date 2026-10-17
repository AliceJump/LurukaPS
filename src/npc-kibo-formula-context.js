import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaExecutionState, arenaExecutionProperty, arenaExecutionResource } from './npc-kibo-execution-properties.js'
import { evaluateArenaFormula } from './npc-kibo-formulas.js'
import { arenaOutputFormulaId, arenaNumericalConfig } from './npc-kibo-damage-amounts.js'
import { arenaUnitGrade } from './npc-kibo-unit-grade.js'

// InnerCalculate args3/4/5 originate from GetAttacker/executor/p_source in
// DamageElement.GetOutput. Target4 is the source's PlayerEntity, not its pet
// or the current controllable hero, and needs a separate provider.
const roles = { 1: 'attacker', 2: 'target', 3: 'source' }

export function arenaFormulaEntity(c, input, item, options = {}) {
    const run = arenaExecutionState(c, input),
        phase = options.phase ?? 'before'
    ensure(['before', 'after'].includes(phase), 'Arena formula phase unavailable', ErrorCode.GameConfig)
    const role = roles[item.target]
    ensure(
        role,
        item.target === 4 ? 'Arena formula source-player unavailable' : 'Arena formula target unavailable',
        ErrorCode.GameConfig,
    )
    const uuid = input.record[role],
        actor = run.actors[uuid]
    const operation = item.operation
    if (operation === arenaNumericalConfig.constants.SEV_HERO_GRADE) {
        ensure(item.prefix === 1, 'Arena special formula prefix semantics unavailable', ErrorCode.GameConfig)
        const before = input.record.before_execution?.[uuid]?.numerical_grade
        const grade = phase === 'before' ? before : arenaUnitGrade(c, uuid)
        if (Number.isInteger(grade)) return Math.fround(grade)
        if (grade?.status === 'resolved') return Math.fround(grade.value)
    }
    // Grade does not require a battle-attribute dictionary, but ordinary
    // property/resource reads still require their complete actor provider.
    ensure(actor?.base_properties, 'Arena formula actor unavailable', ErrorCode.GameConfig)
    if (operation >= 0) {
        ensure(Number.isInteger(item.custom_int), 'Arena formula component unavailable', ErrorCode.GameConfig)
        ensure(
            operation !== arenaNumericalConfig.constants.SHIELD,
            'Arena formula shield state unavailable',
            ErrorCode.GameConfig,
        )
        // The native selector switch pushes0 for an undefined component.
        if (item.custom_int < 0 || item.custom_int > 6) return 0
    } else {
        // These reserved switch entries are native zero branches, not defaults
        // for unknown element counts, ownership, charge or activity state.
        if ([-4, -5, -10].includes(operation)) return 0
        if (![-2, -3].includes(operation)) {
            ensure(item.prefix === 1, 'Arena special formula prefix semantics unavailable', ErrorCode.GameConfig)
            const value = options.special?.({ c, input, item, role, uuid, phase })
            ensure(
                Number.isFinite(value),
                `Arena special formula input unavailable: ${operation}`,
                ErrorCode.GameConfig,
            )
            return Math.fround(value)
        }
    }
    const state = phase === 'before' ? input.record.before_execution?.[uuid] : c.state.combat.entities[uuid]
    ensure(Number.isInteger(state?.alive_state), 'Arena formula life state unavailable', ErrorCode.GameConfig)
    // Native isDead is aliveState in[1,3], not simply HP==0. It redirects
    // property/resource reads to the entity-id death snapshot key.
    ensure(
        state.alive_state < 1 || state.alive_state > 3,
        'Arena formula death snapshot unavailable',
        ErrorCode.GameConfig,
    )
    if (operation >= 0)
        return arenaExecutionProperty(c, input, role, operation, false, 'snapshot-aware', phase, null, item.custom_int)
    return arenaExecutionResource(c, input, role, operation === -2 ? 'hp' : 'sp', 'snapshot-aware', phase)
}

export function arenaExecutionFormulaContext(c, input, options = {}) {
    arenaExecutionState(c, input)
    const guarded =
        (fn) =>
        (...args) => {
            arenaExecutionState(c, input)
            return fn(...args)
        }
    return {
        parameter: guarded(input.parameter),
        entity: (item) => arenaFormulaEntity(c, input, item, options),
        ...(options.random ? { random: guarded(options.random) } : {}),
        ...(options.worldLevel ? { worldLevel: guarded(options.worldLevel) } : {}),
        ...(options.activityAttribute ? { activityAttribute: guarded(options.activityAttribute) } : {}),
        ...(options.onZeroDivision ? { onZeroDivision: guarded(options.onZeroDivision) } : {}),
    }
}

export function arenaExecutionFormula(c, input, options = {}) {
    return evaluateArenaFormula(arenaOutputFormulaId(input.config), arenaExecutionFormulaContext(c, input, options))
}
