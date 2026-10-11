import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { activityTables } from '../src/activity-tables.js'
import { GrowupSystem } from '../src/growup.js'
import { cultivationScore } from '../src/growup-score.js'
const system = new GrowupSystem(activityTables(new Tables(configuration().tables)))
const attrs = (values) => values.map((attr_value, index) => ({ attr_id: 101 + index, attr_value }))
const trails = (star) => [101, 201, 301].map((trail_id) => ({ trail_id, star, score: '6000' }))
test('local final score uses real attributes and table assistant/star points rather than a fixed result', () => {
    const sample = {
        attrs: attrs([1016, 1164, 1034, 1125]),
        chrs: [{ assist_char_id: 100, bond: 170 }],
        trails: trails(3),
    }
    const score = cultivationScore(system, 60001, sample)
    assert.deepEqual(score, { version: 1, attributes: 8678, assistants: 500, examinations: 2700, total: 11878 })
    const more = structuredClone(sample)
    more.attrs[0].attr_value += 123
    assert.equal(cultivationScore(system, 60001, more).total, score.total + 246)
    more.trails = trails(2)
    assert.equal(cultivationScore(system, 60001, more).examinations, 1800)
    more.chrs[0].bond = 0
    assert.equal(cultivationScore(system, 60001, more).assistants, 50)
    assert.deepEqual(sample.trails, trails(3), 'Battle scores and stars remain untouched')
})
test('complete legacy ending snapshots are upgraded once and never added repeatedly', () => {
    const entry = {},
        g = system.ensure(entry, 60001)
    const record = {
        id: 101,
        top_rating: '1800',
        attrs: attrs([577, 243, 243, 243]),
        chrs: [{ assist_char_id: 100, bond: 0 }],
        trails: trails(2),
        starting_ids: [101],
    }
    g.end_data.complete_end = [record]
    g.final_wins = [{ starting_id: 101, score: '1800', finish_ends: [101] }]
    delete entry.growupHistoryScoreVersion
    system.ensure(entry, 60001)
    assert.equal(record.top_rating, '4462')
    assert.equal(g.final_wins[0].score, '4462')
    const saved = structuredClone(g)
    system.ensure(entry, 60001)
    assert.deepEqual(g, saved)
})
test('score calculation refuses incomplete or duplicated evidence instead of granting fabricated points', () => {
    const sample = { attrs: attrs([100, 200, 300, 400]), chrs: [], trails: trails(3) }
    assert.throws(() => cultivationScore(system, 60001, { ...sample, attrs: sample.attrs.slice(0, 3) }), /Incomplete/)
    assert.throws(
        () =>
            cultivationScore(system, 60001, {
                ...sample,
                trails: [sample.trails[0], sample.trails[0], sample.trails[2]],
            }),
        /Invalid/,
    )
    assert.throws(
        () => cultivationScore(system, 60001, { ...sample, chrs: [{ assist_char_id: 999999, bond: 0 }] }),
        /missing/,
    )
    assert.throws(() => cultivationScore(system, 60001, { ...sample, chrs: [{ assist_char_id: 100 }] }), /Invalid/)
})
