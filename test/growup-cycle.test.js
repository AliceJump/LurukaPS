import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { activityTables } from '../src/activity-tables.js'
import { GrowupSystem } from '../src/growup.js'
import { assistantLevel, prepareGrowupCycle, populateGrowupEvents, growupCommonTriggers } from '../src/growup-cycle.js'
const tables = activityTables(new Tables(configuration().tables))
const system = new GrowupSystem(tables)
const high = (maximum) => maximum - 1
function start() {
    const entry = {}
    system.start(entry, 60001, { starting_id: 101, select_assist_char_ids: [] }, 1, high)
    return entry
}
test('assistant rank boundaries follow CBT3 lookup and preview stays stable across reads', () => {
    const entry = start(),
        g = entry.growup,
        assistant = g.assist_chars[0]
    assert.deepEqual(g.train_options[0].assist_char_ids, [100])
    for (const [bond, level] of [
        [0, 0],
        [24, 0],
        [25, 1],
        [54, 1],
        [55, 2],
    ]) {
        assistant.bond = bond
        assert.equal(assistantLevel(system, assistant).bondLevel, level)
    }
    const before = structuredClone(g)
    system.prepare(entry, 60001, () => {
        throw new Error('Preview rerolled')
    })
    assert.deepEqual(g, before)
})
test('preselected bond training yields client result 3 and table bonuses, then adds table bond points', () => {
    const entry = start(),
        g = entry.growup
    g.assist_chars[0].bond = 25
    g.assist_chars[0].is_bond_train = true
    const result = system.train(entry, 60001, 1, high)
    // (15+1) * 1.2 great success * 1.15 assistant * 1.2 bond = 26.496.
    assert.equal(result.result, 3)
    assert.equal(result.changes[0].attr_value, 26)
    assert.equal(g.assist_chars[0].bond, 33)
    assert.equal(g.growup_train_attr[0].attr_value, 86)
})
test('bond preview uses the table probability boundary and is not rerolled on a second read', () => {
    for (const [draw, expected] of [
        [1999, true],
        [2000, false],
    ]) {
        const entry = start(),
            g = entry.growup
        g.assist_chars[0].bond = 25
        g.action_count++
        const draws = [0, draw]
        prepareGrowupCycle(system, entry, 60001, () => draws.shift())
        assert.equal(g.assist_chars[0].is_bond_train, expected)
        assert.deepEqual(g.train_options[0].assist_char_ids, [100])
        prepareGrowupCycle(system, entry, 60001, () => {
            throw new Error('Bond preview rerolled')
        })
        assert.equal(g.assist_chars[0].is_bond_train, expected)
    }
})
test('day advancement expires duration-one events without erasing completion history', () => {
    const entry = start(),
        g = entry.growup
    g.event_datas.push({ event_id: 2055, cur_step: 0, finish: false, duration: 1, event_option_ids: [] })
    g.evt_records.push({ id: 2001, complete_cnt: 1 })
    g.cur_growup_stage++
    system.afterAction(entry, 60001, true, high)
    assert.ok(!g.event_datas.some((x) => x.event_id === 2055))
    assert.deepEqual(g.evt_records, [{ id: 2001, complete_cnt: 1 }])
})
test('day table unlocks random encounters; eligibility, pending state and repeat limits are respected', () => {
    const entry = start(),
        g = entry.growup
    growupCommonTriggers(system, g, 60001, { kind: 2, variant: 2, result: 1, detail: 3 }, high)
    populateGrowupEvents(system, g, 60001, () => 0)
    const random = g.event_datas.filter(
        (x) => tables.get('game_events_cul_event').find((r) => r.id === x.event_id).eventType === 3,
    )
    assert.ok(random.length > 0)
    const pending = random[0]
    pending.cur_step = 777
    populateGrowupEvents(system, g, 60001, high)
    assert.equal(g.event_datas.find((x) => x.event_id === pending.event_id).cur_step, 777)
    const row = tables.get('game_events_cul_event').find((x) => x.id === pending.event_id)
    g.evt_records.push({ id: row.id, complete_cnt: row.repeattime })
    g.event_datas = g.event_datas.filter((x) => x.event_id !== row.id)
    populateGrowupEvents(system, g, 60001, () => 0)
    assert.ok(!g.event_datas.some((x) => x.event_id === row.id))
})
test('legacy run recovers guaranteed unlocks once without rerolling historic rare triggers', () => {
    const entry = start()
    entry.growup.cur_growup_stage = 3
    delete entry.growupRuntime
    system.prepare(entry, 60001, high)
    assert.ok(entry.growup.unlock_events.includes(2002))
    assert.equal(entry.growup.assist_chars.length, 1)
    system.prepare(entry, 60001, () => {
        throw new Error('Migration rerolled')
    })
})
test('event checks apply both actual table branches and store their result for the client', () => {
    for (const [draw, success] of [
        [0, false],
        [5, true],
    ]) {
        const entry = start(),
            g = entry.growup
        g.event_datas = [{ event_id: 2001, finish: false, cur_step: 501, duration: 1, event_option_ids: [] }]
        const steps = tables.get('game_events_cul_eventstep').filter((x) => x.systemId === 2001)
        const step = steps.find((x) => String(x.option).split('|').includes('200101'))
        const option = tables.get('game_events_cul_eventoption').find((x) => x.optionId === 200101)
        g.cur_event_data = { activity_id: 60001, event_id: 2001, cur_step: step.step, event_option_infos: [] }
        const reply = system.selectEvent(entry, 60001, { event_id: 2001, optional_id: 200101 }, () => draw)
        assert.equal(reply.is_identify_success, success)
        assert.equal(g.cur_event_data.cur_step, success ? option.nextStep : option.nextStepFail)
        assert.equal(g.cur_event_data.event_option_infos[0].is_identify_success, success)
    }
})
test('final examination day clears an obsolete phase-two selection without altering scores or choosing an ending', () => {
    const entry = start(),
        g = entry.growup
    Object.assign(g, {
        cur_stage: 3,
        cur_growup_stage: 12,
        cur_growup_trail_stage: 2,
        action_count: 2,
        select_trail_id: 201,
    })
    g.trails = [
        { trail_id: 101, star: 2, score: '4500' },
        { trail_id: 201, star: 2, score: '4840' },
    ]
    g.final_score = '1000'
    const history = structuredClone(g.trails)
    assert.equal(system.advance(g, 60001), true)
    assert.equal(g.cur_growup_stage, 13)
    assert.equal(g.cur_growup_trail_stage, 3)
    assert.equal(g.select_trail_id, 0)
    g.select_trail_id = 201 // Actual old-save shape, restored through ensure/snapshot.
    system.ensure(entry, 60001)
    assert.equal(g.select_trail_id, 0)
    assert.deepEqual(g.trails, history)
    assert.equal(g.final_score, '1000')
    g.select_trail_id = 301
    system.ensure(entry, 60001)
    assert.equal(g.select_trail_id, 301)
    g.cur_stage = 4
    system.ensure(entry, 60001)
    assert.equal(g.select_trail_id, 301, 'Completed run retains its ending selection')
})
test('old spent-point saves migrate once to remaining travel points and trial-day saves stay closed', () => {
    for (const [spent, remaining] of [
        [0, 2],
        [1, 1],
        [2, 0],
    ]) {
        const entry = start(),
            g = entry.growup
        g.cur_cost_expedition_count = spent
        delete entry.growupRuntime.expeditionRemainingVersion
        system.ensure(entry, 60001)
        assert.equal(g.cur_cost_expedition_count, remaining)
        system.ensure(entry, 60001)
        assert.equal(g.cur_cost_expedition_count, remaining, 'Migration must not reverse remaining points again')
    }
    const entry = start()
    Object.assign(entry.growup, { cur_growup_stage: 4, cur_growup_trail_stage: 1, cur_cost_expedition_count: 0 })
    delete entry.growupRuntime.expeditionRemainingVersion
    system.ensure(entry, 60001)
    assert.equal(entry.growup.cur_cost_expedition_count, 0)
})
