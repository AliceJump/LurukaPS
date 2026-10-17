import { ErrorCode } from './error-codes.js'
import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'
function weighted(text) {
    return String(text || '')
        .split('|')
        .filter(Boolean)
        .map((s) => {
            const [id, weight, ...rest] = s.split('#').map(Number)
            ensure(
                !rest.length && Number.isInteger(id) && id > 0 && Number.isSafeInteger(weight) && weight >= 0,
                'Invalid egg pool entry',
                ErrorCode.GameConfig,
            )
            return { id, weight }
        })
        .filter((x) => x.weight > 0)
}
function draw(rows, rng) {
    const total = rows.reduce((n, r) => n + r.weight, 0)
    ensure(
        Number.isSafeInteger(total) && total > 0 && total < 2 ** 48,
        'Invalid hatch pool total',
        ErrorCode.GameConfig,
    )
    let value = rng(total)
    ensure(Number.isInteger(value) && value >= 0 && value < total, 'Invalid random draw')
    for (const row of rows) {
        if (value < row.weight) return row
        value -= row.weight
    }
    throw Error('Unreachable weighted draw')
}
export function eggSpeciesPools(tables, eggId) {
    const config = tables.find('pet_egg', eggId),
        pools = tables.find('egg_poolitem', eggId)
    ensure(config && pools, 'Missing egg species configuration', ErrorCode.GameConfig)
    const probability = tables.get('egg_prob_list').find((r) => r.probList === config.probList)
    ensure(probability, 'Missing egg probability list', ErrorCode.GameConfig)
    // Native PagePetEggInfoTip.RefreshPageData RVA 0x29837C0 groups R4+R5 and R1+R2+R3.
    const grouped = [
        ['SSR', probability.probability_SSR, pools.kipopool1],
        ['SR', probability.probability_SR, pools.kipopool2],
        ['R4_R5', probability.probability_R4 + probability.probability_R5, pools.kipopool3],
        [
            'R1_R2_R3',
            probability.probability_R1 + probability.probability_R2 + probability.probability_R3,
            pools.kipopool4,
        ],
    ]
    ensure(
        grouped.every(([, n]) => Number.isSafeInteger(n) && n >= 0) && grouped.reduce((n, [, w]) => n + w, 0) === 10000,
        'Invalid egg probability total',
        ErrorCode.GameConfig,
    )
    const groups = grouped
        .filter(([, w]) => w > 0)
        .map(([name, weight, id]) => {
            const pool = tables.find('egg_pooltype', id)
            ensure(pool, `Missing egg pool ${id}`, ErrorCode.GameConfig)
            const candidates = weighted(pool.poolTypeProb)
            ensure(candidates.length, 'Empty egg pool', ErrorCode.GameConfig)
            for (const row of candidates)
                ensure(
                    tables.find('pet', row.id) && tables.find('template_value', row.id),
                    `Missing hatch pet configuration ${row.id}`,
                    ErrorCode.GameConfig,
                )
            return { name, weight, id, candidates }
        })
    return { groups, pools, probability }
}
export function selectBaseHatchSpecies(tables, eggId, rng = randomInt) {
    const { groups, pools, probability } = eggSpeciesPools(tables, eggId)
    ensure(!pools.guaranteegrouprule, 'Guaranteed hatch rules are not yet implemented', ErrorCode.InvalidProtoID)
    ensure(
        !probability.ratio_nonUP_SSR && !probability.ratio_nonUP_SR,
        'Non-UP hatch routing is not yet implemented',
        ErrorCode.InvalidProtoID,
    )
    const group = draw(groups, rng)
    return draw(group.candidates, rng).id
}
