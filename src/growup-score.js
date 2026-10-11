import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { assistantLevel } from './growup-cycle.js'
const policy = JSON.parse(fs.readFileSync(new URL('../configs/growup-score-policy.json', import.meta.url)))
export const growupScoreVersion = policy.version
export function cultivationScore(system, id, { attrs, chrs, trails }) {
    const expected = system.tables
        .get('game_events_cul_attr')
        .filter((x) => x.systemId === id)
        .map((x) => x.AttrId)
    ensure(
        attrs?.length === expected.length &&
            new Set(attrs.map((x) => x.attr_id)).size === expected.length &&
            attrs.every((x) => expected.includes(x.attr_id) && Number.isSafeInteger(x.attr_value) && x.attr_value >= 0),
        'Incomplete cultivation score attributes',
        1007,
    )
    const attributes = attrs.reduce((sum, x) => sum + x.attr_value, 0) * policy.attributeMultiplier
    ensure(
        Array.isArray(chrs) &&
            new Set(chrs.map((x) => x.assist_char_id)).size === chrs.length &&
            chrs.every((x) => Number.isSafeInteger(x.bond) && x.bond >= 0),
        'Invalid cultivation score assistants',
        1007,
    )
    const assistants = chrs.reduce((sum, x) => sum + assistantLevel(system, x).finalscore, 0)
    ensure(trails?.length === 3, 'Incomplete cultivation score examinations', 1007)
    const phases = new Set()
    const examinations = trails.reduce((sum, result) => {
        const trial = system.tables
            .get('game_events_cul_trial')
            .find((x) => x.systemId === id && x.trialId === result.trail_id)
        ensure(
            trial &&
                [1, 2, 3].includes(trial.phase) &&
                !phases.has(trial.phase) &&
                Number.isInteger(result.star) &&
                result.star >= 1 &&
                result.star <= 3,
            'Invalid cultivation score examination',
            1007,
        )
        phases.add(trial.phase)
        const bonus = Number(String(trial.finalscore).split('|')[result.star - 1])
        ensure(Number.isSafeInteger(bonus) && bonus >= 0, 'Missing cultivation score star bonus', 1007)
        return sum + bonus
    }, 0)
    const total = attributes + assistants + examinations
    ensure(Number.isSafeInteger(total) && total >= 0, 'Invalid cultivation final score', 1007)
    return { version: policy.version, attributes, assistants, examinations, total }
}
