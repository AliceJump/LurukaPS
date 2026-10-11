import { ensure } from './handlers/common.js'
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const pairs = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map((x) => x.split('#').map(Number))
export function trainingFailureRate(afterStamina) {
    // CBT3 TrainingData.GetFailureResult, IL 06005032; use float32 intermediates.
    if (afterStamina <= 0) return 10000
    const root = Math.fround(Math.sqrt(Math.fround(afterStamina / 50)))
    const factor = Math.fround(Math.pow(Math.min(Math.fround(afterStamina / 20), 1), 2))
    return 10000 - Math.min(10000, Math.trunc(Math.fround(10500 * Math.fround(root * factor))))
}
export class GrowupSystem {
    constructor(tables) {
        this.tables = tables
    }
    config(id) {
        const row = this.tables.get('game_events_cul').find((x) => x.Id === id)
        ensure(row, 'Missing cultivation configuration', 1007)
        return row
    }
    fresh(id) {
        const config = this.config(id)
        return {
            cur_stage: 0,
            cur_growup_stage: 0,
            cur_growup_trail_stage: 0,
            cur_starting_id: 0,
            cur_cost_expedition_count: 0,
            action_count: 0,
            growup_stamina: { stamina: config.defaultStamina },
            growup_mood: { mood_level: config.defaultMood },
            growup_train_attr: this.tables
                .get('game_events_cul_attr')
                .filter((x) => x.systemId === id)
                .map((x) => ({ attr_id: x.AttrId, attr_value: 0, cur_node: 0 })),
            growup_status: [],
            growup_trait: [],
            event_datas: [],
            trails: [],
            train_options: [],
            assist_chars: [],
            growup_train_exp: 0,
            select_effects: [],
            final_wins: [],
            select_trail_id: 0,
            skill_tree_data: { chains: [], unlocked_nodes: [] },
            outside_datas: [],
            outside_score: 0,
            end_data: { complete_end: [] },
            unlock_events: [],
            final_score: '0',
            evt_records: [],
            rest_interact_pending_id: 0,
            guid: '0',
            archive_guid: '0',
        }
    }
    ensure(entry, id) {
        return (entry.growup ??= this.fresh(id))
    }
    condition(rule, g) {
        if (!rule) return true
        return String(rule)
            .split('|')
            .every((text) => {
                const [kind, activity, a, b] = text.split('#').map(Number)
                if (kind === 80001) return (g.growup_train_attr.find((x) => x.attr_id === a)?.attr_value ?? 0) >= b
                if (kind === 80004) return g.final_wins.some((x) => x.starting_id === a)
                return false
            })
    }
    weighted(rows, key, randomInt) {
        const choices = rows.filter((x) => Number.isSafeInteger(x[key]) && x[key] > 0)
        const total = choices.reduce((n, x) => n + x[key], 0)
        ensure(total > 0 && Number.isSafeInteger(total), 'Empty cultivation probability table', 1007)
        let draw = randomInt(total)
        for (const row of choices) {
            draw -= row[key]
            if (draw < 0) return row
        }
        ensure(false, 'Invalid cultivation random draw')
    }
    effects(g, id, value) {
        const config = this.config(id)
        for (const effectId of ids(value)) {
            const row = this.tables.get('game_events_cul_effect').find((x) => x.Id === effectId)
            ensure(row, `Unknown cultivation effect ${effectId}`, 1007)
            if (row.type === 1 || row.type === 2) {
                const n = Number(row.param)
                ensure(Number.isFinite(n), 'Invalid cultivation stamina effect', 1007)
                g.growup_stamina.stamina = Math.max(
                    0,
                    Math.min(config.maxStamina, g.growup_stamina.stamina + (row.type === 1 ? n : -n)),
                )
            } else if (row.type === 3) {
                for (const [attr, value, mode = 0] of pairs(row.param)) {
                    ensure(mode === 0, 'Cultivation relative attribute effect is not implemented', 1007)
                    const target = g.growup_train_attr.find((x) => x.attr_id === attr)
                    ensure(target, 'Unknown cultivation attribute', 1007)
                    target.attr_value = Math.max(0, Math.min(config.maxAttr, target.attr_value + value))
                }
            } else if (row.type === 5 || row.type === 6) {
                ensure(!row.param, 'Parameterized cultivation mood effect is not implemented', 1007)
                // Empty-param MoodLevel/MoodDown are one-step effects. This is a
                // compatibility inference recorded in growup-cbt3.md.
                const levels = this.tables
                    .get('game_events_cul_mood')
                    .filter((x) => x.systemId === id)
                    .map((x) => x.moodLevel)
                g.growup_mood.mood_level = Math.max(
                    Math.min(...levels),
                    Math.min(Math.max(...levels), g.growup_mood.mood_level + (row.type === 5 ? 1 : -1)),
                )
            } else if (row.type === 29) {
                for (const eventId of ids(row.param))
                    if (!g.unlock_events.includes(eventId)) g.unlock_events.push(eventId)
            } else if (row.type === 10) {
                for (const statusId of ids(row.param)) {
                    const status = this.tables
                        .get('game_events_cul_status')
                        .find((x) => x.statusID === statusId && x.activityid === id)
                    ensure(status, 'Unknown cultivation status', 1007)
                    const old = g.growup_status.find((x) => x.status_id === statusId)
                    if (old) old.cur_duration_time = status.duration
                    else
                        g.growup_status.push({
                            status_id: statusId,
                            cur_duration_time: status.duration,
                            cur_enable_time: g.cur_growup_stage,
                        })
                }
            } else ensure(false, `Cultivation effect ${effectId} type ${row.type} is not implemented`, 1007)
        }
    }
    populateEvents(g, id) {
        const records = new Map(g.evt_records.map((x) => [x.id, x.complete_cnt]))
        const eligible = this.tables
            .get('game_events_cul_event')
            .filter(
                (x) =>
                    x.systemId === id &&
                    x.eventType === 2 &&
                    this.condition(x.unlockCondition, g) &&
                    (records.get(x.id) ?? 0) < x.repeattime,
            )
        g.event_datas = eligible.map((x) => ({
            event_id: x.id,
            cur_step: 0,
            finish: false,
            event_option_ids: [],
            duration: x.duration,
        }))
        // TODO: commontrigger/commoneffect mandatory events and per-day random
        // encounters need their exact timing graph; don't invent event chances.
    }
    start(entry, id, request, accountId) {
        const old = this.ensure(entry, id)
        const starting = this.tables
            .get('game_events_cul_starting')
            .find((x) => x.startingId === request.starting_id && x.systemId === id)
        ensure(starting && this.condition(starting.condition, old), 'Cultivation starting scenario is locked')
        const requested = request.select_assist_char_ids ?? []
        const initial = ids(starting.initialCharacter)
        const chosen = requested.filter((x) => !initial.includes(x))
        ensure(
            new Set(requested).size === requested.length && chosen.length <= starting.exCharAmonut,
            'Invalid cultivation assist selection',
        )
        ensure(
            chosen.every(
                (x) =>
                    this.tables.get('game_events_cul_assist').some((a) => a.assistId === x && a.systemId === id) &&
                    !ids(starting.lockCharacter).includes(x) &&
                    !ids(starting.initialCharacter).includes(x),
            ),
            'Cultivation assist is unavailable',
        )
        if (old.cur_starting_id) {
            ensure(old.cur_starting_id === starting.startingId, 'Cultivation run already started')
            return old
        }
        const g = this.fresh(id)
        g.final_wins = old.final_wins
        g.end_data = old.end_data
        g.outside_datas = old.outside_datas
        g.outside_score = old.outside_score
        g.cur_starting_id = starting.startingId
        g.cur_stage = 1
        g.cur_growup_stage = 1
        entry.nextGrowupGuid = (entry.nextGrowupGuid ?? 0) + 1
        g.guid = String((BigInt(accountId) << 32n) | BigInt(entry.nextGrowupGuid))
        g.assist_chars = [...ids(starting.initialCharacter), ...chosen].map((assist_char_id) => ({
            assist_char_id,
            bond: 0,
            is_bond_train: false,
        }))
        g.train_options = [
            ...new Set(
                this.tables
                    .get('game_events_cul_train')
                    .filter((x) => x.systemId === id)
                    .map((x) => x.trainOption),
            ),
        ].map((train_option_id) => ({ train_option_id, train_lv: 1, train_exp: 0, assist_char_ids: [] }))
        this.effects(g, id, starting.effect)
        this.populateEvents(g, id)
        g.day_start_snapshot = { train_attrs: structuredClone(g.growup_train_attr), statuses: [] }
        entry.growup = g
        return g
    }
    requireRun(entry, id) {
        const g = this.ensure(entry, id)
        ensure(g.cur_starting_id > 0, 'Cultivation run has not started')
        ensure(g.cur_growup_trail_stage !== g.cur_stage, 'Complete the configured cultivation trial first')
        ensure(
            !g.rest_interact_pending_id && !g.cur_event_data?.event_id,
            'Finish the current cultivation interaction first',
        )
        return g
    }
    finish(g, id, trial) {
        const ending = this.tables
            .get('game_events_cul_end')
            .find((x) => x.systemId === id && x.endingId === trial.ending && x.trial === trial.trialId)
        ensure(ending && this.condition(ending.condition, g), 'Cultivation ending configuration unavailable', 1007)
        ensure(
            [1, 2, 3].every((phase) => {
                const result = g.trails[phase - 1],
                    row = this.tables
                        .get('game_events_cul_trial')
                        .find((x) => x.systemId === id && x.trialId === result?.trail_id)
                return row?.phase === phase && result.star > 0
            }),
            'Cultivation examinations are incomplete',
        )
        // Keep the existing staged final_score accumulation unchanged. This
        // protocol fix records completion; it does not introduce a score formula.
        const snapshot = {
            id: ending.endingId,
            top_rating: g.final_score,
            chrs: structuredClone(g.assist_chars),
            attrs: structuredClone(g.growup_train_attr),
            trails: structuredClone(g.trails),
            starting_ids: [g.cur_starting_id],
        }
        const book = g.end_data.complete_end,
            old = book.find((x) => x.id === ending.endingId)
        if (!old) book.push(snapshot)
        else {
            const starts = [...new Set([...(old.starting_ids ?? []), g.cur_starting_id])]
            if (BigInt(snapshot.top_rating) > BigInt(old.top_rating)) Object.assign(old, snapshot)
            old.starting_ids = starts
        }
        let win = g.final_wins.find((x) => x.starting_id === g.cur_starting_id)
        if (!win)
            g.final_wins.push((win = { starting_id: g.cur_starting_id, score: '0', assist_chars: [], finish_ends: [] }))
        if (BigInt(g.final_score) > BigInt(win.score)) {
            win.score = g.final_score
            win.assist_chars = structuredClone(g.assist_chars)
        }
        win.finish_ends = [...new Set([...win.finish_ends, ending.endingId])]
        g.cur_stage = 4
        g.cur_growup_trail_stage = 4 // RuntimeData.PlayDone checks this field.
        g.action_count = 0
        return snapshot
    }
    advance(g, id) {
        const config = this.config(id)
        g.action_count++
        if (g.action_count < config.actionCount) return false
        g.action_count = 0
        g.cur_growup_stage++
        g.cur_cost_expedition_count = 0
        const last = Array.from({ length: g.cur_stage }, (_, i) => config[`trainingDayNum${i + 1}`]).reduce(
            (n, x) => n + x,
            0,
        )
        if (g.cur_growup_stage > last) {
            g.cur_growup_trail_stage = g.cur_stage
            const trials = ids(config[`trial${g.cur_stage}`])
            if (trials.length === 1) g.select_trail_id = trials[0]
        }
        g.day_start_snapshot = {
            train_attrs: structuredClone(g.growup_train_attr),
            statuses: structuredClone(g.growup_status),
        }
        return true
    }
    train(entry, id, optionId, randomInt) {
        const g = this.requireRun(entry, id),
            config = this.config(id),
            option = g.train_options.find((x) => x.train_option_id === optionId)
        ensure(option, 'Unknown cultivation training option')
        const row = this.tables
            .get('game_events_cul_train')
            .find((x) => x.systemId === id && x.trainOption === optionId && x.trainLevel === option.train_lv)
        ensure(row, 'Missing cultivation training level', 1007)
        ensure(!row.cost, 'Paid cultivation training is not implemented', 1007)
        const assigned = option.assist_char_ids.map((x) => g.assist_chars.find((a) => a.assist_char_id === x))
        // Bond/assist placement is not ported yet. Known status percentages
        // below follow the client arithmetic; other modifiers are rejected.
        ensure(!assigned.length, 'Cultivation assist training modifiers are not implemented', 1007)
        const statusModifiers = new Map(g.growup_train_attr.map((x) => [x.attr_id, 10000]))
        for (const status of g.growup_status) {
            const source = this.tables.get('game_events_cul_status').find((x) => x.statusID === status.status_id)
            ensure(source, 'Unknown cultivation status', 1007)
            for (const effectId of ids(source.effect)) {
                const effect = this.tables.get('game_events_cul_effect').find((x) => x.Id === effectId)
                ensure(
                    effect && [15, 28].includes(effect.type),
                    'Cultivation status training effect is not implemented',
                    1007,
                )
                if (effect.type === 15)
                    for (const [attr, bonus] of pairs(effect.param))
                        statusModifiers.set(attr, (statusModifiers.get(attr) ?? 10000) + bonus)
                else
                    for (const attr of statusModifiers.keys())
                        statusModifiers.set(attr, statusModifiers.get(attr) + Number(effect.param))
            }
        }
        const remaining = g.growup_stamina.stamina - row.costStamina
        const failure = trainingFailureRate(remaining)
        // ModuleRaisingResult.OnTrainResult subtracts one before indexing
        // fail/success/bond artwork. The wire values are 1/2/3, not 0/1/2.
        const result = randomInt(10000) < failure ? 1 : 2
        const mood = this.tables
            .get('game_events_cul_mood')
            .find((x) => x.systemId === id && x.moodLevel === g.growup_mood.mood_level)
        ensure(mood, 'Unknown cultivation mood', 1007)
        const modifier = result === 1 ? config.failModifier : config.successModifier
        const changes = []
        for (const [attr, value] of pairs(row.addTrainAttr)) {
            const target = g.growup_train_attr.find((x) => x.attr_id === attr)
            ensure(target, 'Unknown cultivation training attribute', 1007)
            let amount = BigInt(value) * 10000n
            amount = (amount * BigInt(modifier)) / 10000n
            amount = (amount * BigInt(statusModifiers.get(attr))) / 10000n
            amount = (amount * BigInt(mood.moodModifier)) / 10000n
            const before = target.attr_value
            target.attr_value = Math.min(config.maxAttr, before + Number(amount / 10000n))
            changes.push({ attr_id: attr, attr_value: target.attr_value - before })
        }
        g.growup_stamina.stamina = Math.max(0, remaining)
        option.train_exp += row.addEXP
        const levels = this.tables
            .get('game_events_cul_train')
            .filter((x) => x.systemId === id && x.trainOption === optionId)
            .sort((a, b) => a.trainLevel - b.trainLevel)
        while (true) {
            const next = levels.find((x) => x.trainLevel === option.train_lv + 1)
            if (!next || option.train_exp < next.needEXP) break
            option.train_exp -= next.needEXP
            option.train_lv = next.trainLevel
        }
        g.growup_train_exp += row.addEXP
        return { result, changes, dayChanged: this.advance(g, id), failure }
    }
    rest(entry, id, randomInt) {
        const g = this.requireRun(entry, id),
            config = this.config(id)
        const row = this.weighted(
            this.tables.get('game_events_cul_rest').filter((x) => x.systemId === id),
            'weight',
            randomInt,
        )
        g.growup_stamina.stamina = Math.min(config.maxStamina, g.growup_stamina.stamina + row.addStamina)
        this.effects(g, id, row.effect)
        if (row.type === 3) g.rest_interact_pending_id = row.rest
        return { row, dayChanged: row.type !== 3 && this.advance(g, id) }
    }
    eventInfo(g, id) {
        return g.cur_event_data ?? { activity_id: id, event_id: 0, cur_step: 0, event_option_infos: [] }
    }
    selectEvent(entry, id, request, randomInt) {
        const g = this.ensure(entry, id),
            config = this.config(id)
        ensure(
            g.cur_starting_id > 0 && !g.rest_interact_pending_id && g.cur_growup_trail_stage !== g.cur_stage,
            'Cultivation event is unavailable in current phase',
        )
        const event = g.event_datas.find((x) => x.event_id === request.event_id && !x.finish)
        ensure(event, 'Cultivation event was not offered')
        const steps = this.tables.get('game_events_cul_eventstep').filter((x) => x.systemId === request.event_id)
        if (!g.cur_event_data?.event_id) {
            ensure(!request.optional_id, 'Begin the cultivation event before selecting an option')
            const first = steps.find((x) => x.isFirstStep === 1)
            ensure(first, 'Missing cultivation event first step', 1007)
            g.cur_event_data = {
                activity_id: id,
                event_id: event.event_id,
                cur_step: first.step,
                event_option_infos: [],
            }
            event.cur_step = first.step
            return { activity_id: id, event_id: event.event_id, optional_id: 0, is_identify_success: true }
        }
        ensure(g.cur_event_data.event_id === event.event_id, 'Another cultivation event is active')
        const step = steps.find((x) => x.step === g.cur_event_data.cur_step)
        ensure(step, 'Missing cultivation event step', 1007)
        let next = step.nextStep
        let selected = request.optional_id ?? 0
        if (!selected && step.option) {
            const options = this.tables
                .get('game_events_cul_eventoption')
                .filter(
                    (x) =>
                        ids(step.option).includes(x.optionId) &&
                        x.buttonType === 0 &&
                        this.condition(x.unlockCondition, g),
                )
            ensure(options.length, 'Select an offered cultivation event option')
            selected = this.weighted(options, 'weight', randomInt).optionId
        }
        if (selected) {
            ensure(ids(step.option).includes(selected), 'Option does not belong to current cultivation step')
            const option = this.tables.get('game_events_cul_eventoption').find((x) => x.optionId === selected)
            ensure(option && this.condition(option.unlockCondition, g), 'Cultivation event option is locked')
            ensure(!option.checkType, 'Cultivation dice checks are not implemented', 1007)
            ensure(
                g.cur_cost_expedition_count + option.costPoints <= config.expeditionCount,
                'No cultivation expedition points remain',
            )
            this.effects(g, id, option.effect)
            g.cur_cost_expedition_count += option.costPoints
            next = option.nextStep
            g.cur_event_data.event_option_infos.push({ optional_id: option.optionId, is_identify_success: true })
        } else ensure(!step.option, 'Select an offered cultivation event option')
        if (next > 0) {
            ensure(
                steps.some((x) => x.step === next),
                'Missing cultivation event next step',
                1007,
            )
            event.cur_step = next
            g.cur_event_data.cur_step = next
        } else this.finishEvent(g, event)
        return {
            activity_id: id,
            event_id: event.event_id,
            optional_id: selected,
            is_identify_success: true,
        }
    }
    finishEvent(g, event) {
        event.finish = true
        const record = g.evt_records.find((x) => x.id === event.event_id)
        if (record) record.complete_cnt++
        else g.evt_records.push({ id: event.event_id, complete_cnt: 1 })
        delete g.cur_event_data
    }
}
