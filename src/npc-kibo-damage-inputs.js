import { arenaContext } from './npc-kibo-time.js'
import fs from 'node:fs'
import { pairs } from './battle.js'
import { ensure } from './handlers/common.js'
import { u64 } from './combat-state.js'
import { arenaElementOrigin } from './npc-kibo-origins.js'
import {
    arenaObservedIndependentInjection,
    arenaObservedNoSnapshot,
    arenaObservedTriggerInjection,
} from './npc-kibo-elements.js'
import { recordArenaSnapshotLifetime } from './npc-kibo-snapshots.js'
import { arenaExecutionFormula } from './npc-kibo-formula-context.js'
import { arenaOutputFormulaId } from './npc-kibo-damage-amounts.js'
import { arenaUnitGrade } from './npc-kibo-unit-grade.js'

const { elements, conflicts } = JSON.parse(
    fs.readFileSync(new URL('../configs/npc-arena-damage.json', import.meta.url), 'utf8'),
)
const catalogs = new WeakMap(),
    warnings = new Set()
const key = (element, skill, level) => `${element}:${skill}:${level}`

function levelRow(tables, element, skill, level) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = new Map()
        // TDSkillsubEleValueTable.CreateMap uses set_Item, not Add/TryAdd.
        // Preserve table row load order, including the 16 repeated keys.
        for (const row of tables.get('skillsub_ele_value'))
            catalog.set(key(row.elementId, row.skillId, row.level), { row })
        catalogs.set(tables, catalog)
    }
    const entry = catalog.get(key(element, skill, level))
    if (entry && !entry.parameters) entry.parameters = pairs(entry.row.valueParam)
    return entry
}

export function arenaDamageElement(id) {
    return elements[id]?.config ?? null
}

export function arenaElementParameter(tables, element, skill, level, index, end = false) {
    const config = arenaDamageElement(element)
    ensure(
        config,
        conflicts[element] ? 'Ambiguous arena damage configuration' : 'Arena damage configuration unavailable',
        1007,
    )
    ensure(Number.isInteger(index) && index >= 0, 'Invalid arena element parameter index')
    ensure(!end || config.kind === 'dot', 'Arena end-damage parameters unavailable', 1007)
    const entry = levelRow(tables, element, skill, level)
    // Formula arguments use zero-based indexes; override keys are one-based.
    if (entry?.parameters.has(index + 1)) return entry.parameters.get(index + 1)
    return (end ? config.end_parameters : config.parameters)[index] ?? 0
}

function executionProperties(c, run, record) {
    const result = {}
    for (const uuid of new Set([record.attacker, record.source, record.target])) {
        const grade = arenaUnitGrade(c, uuid)
        if (run.actors[uuid]?.base_properties) {
            const entity = c.state.combat.entities[uuid]
            result[uuid] = {
                arena_properties: structuredClone(entity?.arena_properties ?? {}),
                hp: entity?.hp,
                sp: entity?.sp,
                alive_state: entity?.alive_state,
                ...(grade.status === 'resolved' ? { numerical_grade: grade.value } : {}),
            }
        } else if (grade.status === 'resolved') result[uuid] = { numerical_grade: grade.value }
    }
    return result
}

export function recordArenaDamageElement(c, event) {
    c = arenaContext(c)
    // Lifetime ownership can outlive the bounded delayed-damage input cache.
    if (event.op === 2) recordArenaSnapshotLifetime(c, event)
    const run = c.state.combat?.npcDuel,
        id = String(event.uniqueId ?? '0')
    if (!run || run.map_id !== c.state.world.map_id || run.result || id === '0') return
    const previous = run.damage_elements?.[id],
        configId = event.buff?.cfg_id ?? previous?.config_id
    const config = arenaDamageElement(configId)
    if (!config) {
        if (conflicts[configId] && !warnings.has(configId)) {
            warnings.add(configId)
            console.warn(`[npc-arena] Ambiguous damage config ${configId}; damage inputs cannot be reconstructed`)
        }
        // Other element families are expected here. They are not damage.
        if (!previous || ![1, 7, 10].includes(event.op)) return
        const records = { ...run.damage_elements }
        delete records[id] // Reused UID must not retain a different old config.
        c.state.combat.npcDuel = { ...run, damage_elements: records }
        return
    }
    const target = String(event.tar_id ?? previous?.target ?? '0')
    if (!run.actors[target]) return
    let record
    if ([1, 7, 10].includes(event.op)) {
        const same = previous?.config_id === configId && previous.target === target
        if (same)
            record = previous // Retry must not recapture an old snapshot.
        else {
            const buff = event.buff ?? {},
                parent = String(event.parentUniqueId ?? '0'),
                independent = arenaObservedIndependentInjection(c, event),
                noSnapshot = arenaObservedNoSnapshot(c, event),
                trigger = arenaObservedTriggerInjection(c, event)
            // Buff notDel children omit parentUniqueId but retain an Element
            // verify parent. That is not an independent own snapshot.
            const hasElementParent =
                event.verify_info?.source_type === 2 && String(event.verify_info?.related_index ?? '0') !== '0'
            const mode = trigger
                ? trigger.mode
                : noSnapshot
                  ? 'none'
                  : (parent !== '0' || hasElementParent) && !independent
                    ? 'unresolved-parent'
                    : config.snapshot
                      ? 'own'
                      : 'none'
            record = {
                id,
                config_id: configId,
                target,
                parent,
                attacker: String(buff.attacker_id ?? '0'),
                source: String(buff.source_id ?? '0'),
                client_tmp_id: event.clientTmpID ?? 0,
                begin_time: String(buff.begin_time ?? '0'),
                source_behavior_id: String(buff.source_behavior_id ?? '0'),
                verify_info: structuredClone(event.verify_info ?? null),
                snapshot_mode: mode,
                ...(independent ? { snapshot_policy_evidence: independent } : {}),
                ...(noSnapshot ? { snapshot_policy_evidence: noSnapshot } : {}),
                ...(trigger ? { snapshot_policy_evidence: trigger } : {}),
                observed_at: c.now,
                ended: false,
                execution_kind: event.op === 1 ? 'initial' : event.op === 7 ? 'combine' : 'rebuild',
            }
            const origin = arenaElementOrigin(c, event.verify_info, event.buff?.source_behavior_id)
            if (independent) {
                // WeatherControlElement explicitly parses these children with
                // skillId0; this is not a fallback for missing skill origins.
                record.skill_origin = {
                    skill_id: 0,
                    actor: record.source,
                    index: String(event.verify_info?.battle_index ?? '0'),
                    via: 'weather-injection',
                }
            } else if (origin.status === 'resolved')
                record.skill_origin = {
                    skill_id: origin.skill_id,
                    actor: origin.actor,
                    index: origin.index,
                    via: origin.via,
                }
            // Formula and critical-chance reads precede critical-trigger
            // attribute changes, even when native element.snapshot is false.
            record.before_execution = executionProperties(c, run, record)
            if (mode === 'own') {
                // Entry bases remain immutable on run.actors. A native own
                // snapshot stays at creation while later DOT ticks get their
                // own pre-execution inputs for unsnapshotted reads.
                record.snapshots = record.before_execution
                record.snapshot_observed = event.op === 1
            } else if (mode === 'inherited' && trigger) {
                record.snapshots = {}
                record.snapshot_observed = event.op === 1
            }
        }
    } else if (previous) {
        record = { ...previous, ...(event.op === 2 ? { ended: true } : {}) }
        if ([8, 9].includes(event.op) && config.kind === 'dot' && !previous.ended) {
            record.before_execution = executionProperties(c, run, previous)
            record.execution_kind = event.op === 9 ? 'end' : 'tick'
        }
    } else return // An update without the original Add cannot recreate inputs.
    if ([7, 10].includes(event.op)) {
        // Even with an already-known UID these operations are combine/rebuild,
        // not retries of initial damage execution. No fresh pre-execution
        // phase is observable from either report alone.
        record = {
            ...record,
            execution_kind: event.op === 7 ? 'combine' : 'rebuild',
            before_execution: undefined,
            formula_trace: undefined,
        }
    }
    if (event.buff?.damage_cri_pct !== undefined) record = { ...record, critical_random: event.buff.damage_cri_pct }
    const serial = (run.damage_input_serial ?? 0) + 1
    ensure(Number.isSafeInteger(serial), 'Arena damage input sequence exhausted', 1007)
    record = { ...record, observed_serial: serial }
    const records = { ...run.damage_elements }
    records[id] = record
    // DOT.Parse forces runtime isLasting=true even when the serialized field
    // is false. Transient history must not evict still-active DOT inputs.
    const active = [],
        history = []
    for (const [uid, row] of Object.entries(records)) {
        const cfg = arenaDamageElement(row.config_id)
        if (!row.ended && (cfg?.kind === 'dot' || cfg?.isLasting)) active.push([uid, row])
        else history.push([uid, row])
    }
    // Small uint64 keys sort numerically on objects. Recency must not depend
    // on that order, or a recently-ended old DOT would be evicted immediately.
    const age = (a, b) => (a[1].observed_serial ?? 0) - (b[1].observed_serial ?? 0)
    if (history.length > 512) for (const [uid] of history.sort(age).slice(0, history.length - 512)) delete records[uid]
    // These are server memory budgets, not claimed native element limits.
    if (active.length > 2048) {
        for (const [uid] of active.sort(age).slice(0, active.length - 2048)) delete records[uid]
        if (!run.damage_input_overflow)
            console.warn('[npc-arena] Active damage input budget exceeded; oldest contexts are unavailable')
    }
    c.state.combat.npcDuel = {
        ...run,
        damage_elements: records,
        damage_input_serial: serial,
        ...(active.length > 2048 ? { damage_input_overflow: true } : {}),
    }
    recordArenaSnapshotLifetime(c, event)
    if ([1, 8, 9].includes(event.op)) recordFormulaAttempt(c, id)
}

function recordFormulaAttempt(c, id) {
    const run = c.state.combat.npcDuel,
        record = run.damage_elements?.[id]
    if (!record || record.ended || !['initial', 'tick', 'end'].includes(record.execution_kind)) return
    const input = arenaElementExecutionInput(c, id)
    let trace
    if (input.status !== 'ready') trace = { status: 'unresolved', reason: input.origin?.status ?? input.status }
    else {
        const formula = arenaOutputFormulaId(input.config)
        try {
            const value = arenaExecutionFormula(c, input)
            ensure(Number.isFinite(value), 'Arena base formula result is not finite', 1007)
            trace = {
                status: 'calculated',
                formula_id: formula,
                value,
                phase: 'before',
                basis: 'accepted-server-state',
            }
        } catch (error) {
            // This is a derived numerical observation, not authority to reject
            // an otherwise valid HP/element report or grant speculative SP.
            trace = { status: 'unresolved', formula_id: formula, reason: String(error.message) }
            // One missing death-snapshot provider affects many element IDs.
            // Preserve each unresolved trace, but report the shared limitation
            // once instead of flooding the console with per-config warnings.
            const missingDeathSnapshot = trace.reason === 'Arena formula death snapshot unavailable'
            const warning = missingDeathSnapshot
                ? 'formula:death-snapshot'
                : `formula:${record.config_id}:${formula}:${trace.reason}`
            if (!warnings.has(warning)) {
                if (warnings.size >= 256) warnings.delete(warnings.values().next().value)
                warnings.add(warning)
                console.warn(
                    missingDeathSnapshot
                        ? '[npc-arena] Formula diagnostic: death snapshot unavailable; client damage processing continues (further identical dependency warnings suppressed)'
                        : `[npc-arena] Base formula unresolved for ${record.config_id}/${formula}: ${trace.reason}`,
                )
            }
        }
    }
    c.state.combat.npcDuel = {
        ...run,
        damage_elements: { ...run.damage_elements, [id]: { ...record, formula_trace: trace } },
    }
}

export function arenaDamageRecord(c, hurt) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id) return null
    const uid = String(hurt.element_uniqueId ?? '0'),
        temp = hurt.element_tempId ?? 0
    let record = run.damage_elements?.[uid]
    if (uid === '0' && temp) {
        const matches = Object.values(run.damage_elements ?? {}).filter(
            (row) => row.target === hurt.tar_id && row.client_tmp_id === temp,
        )
        if (matches.length === 1) record = matches[0]
    }
    if (!record || record.target !== hurt.tar_id || (temp && record.client_tmp_id !== temp)) return null
    return record
}

export function arenaDamageRecoveryPath(record) {
    if (record?.execution_kind === 'initial') return 'initial-execution'
    if (['tick', 'end', 'combine'].includes(record?.execution_kind)) return 'none'
    return 'unresolved'
}

export function arenaDamageInput(c, hurt) {
    c = arenaContext(c)
    // 'ready' describes the element/parameter index only. The damage evaluator
    // must still check property roles, special variables, rolls and formulas.
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id) return { status: 'not-in-arena' }
    const record = arenaDamageRecord(c, hurt)
    if (!record) return { status: 'element-not-found' }
    return executionInput(c, record, hurt.skill_id ?? 0, 'hurt-info')
}

export function arenaElementExecutionInput(c, id) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id || run.result || run.entities_sent === false)
        return { status: 'not-in-arena' }
    const record = run.damage_elements?.[u64(id)]
    if (!record) return { status: 'element-not-found' }
    const origin = record.skill_origin
        ? { status: 'resolved', ...record.skill_origin }
        : arenaElementOrigin(c, record.verify_info, record.source_behavior_id)
    if (origin.status !== 'resolved') return { status: 'skill-origin-unavailable', record, origin }
    return { ...executionInput(c, record, origin.skill_id, origin.via ?? 'lineage'), origin }
}

function executionInput(c, record, skill, skillSource) {
    const run = c.state.combat.npcDuel
    const source = run.actors[record.source]
    if (record.source !== '0' && !source?.skill_levels) return { status: 'source-skill-levels-unavailable', record }
    const level = source?.skill_levels[skill] ?? 1
    const baseConfig = arenaDamageElement(record.config_id),
        end = record.execution_kind === 'end'
    const config = end
        ? {
              ...baseConfig,
              real_formula_id: baseConfig.formula_id,
              formula_id: baseConfig.end_formula_id,
              parameters: baseConfig.end_parameters,
          }
        : baseConfig
    if (end && !(config.formula_id > 0)) return { status: 'end-formula-unavailable', record }
    return {
        status: record.snapshot_mode === 'unresolved-parent' ? 'inherited-snapshot-unresolved' : 'ready',
        record,
        recovery_path: arenaDamageRecoveryPath(record),
        config,
        skill,
        skill_source: skillSource,
        level,
        parameter: (index) => arenaElementParameter(c.tables, record.config_id, skill, level, index, end),
    }
}
