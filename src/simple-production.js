import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { completed } from './production.js'
import { grantRewards } from './rewards.js'

function multiplied(rows, count) {
    return rows.map((row) => {
        const itemnum = row.itemnum * count
        ensure(Number.isSafeInteger(itemnum) && itemnum > 0 && itemnum <= 0xffffffff, 'Production quantity overflow')
        return { ...row, itemnum }
    })
}
const credited = (job) => job.credited ?? job.finished ?? 0
export function rememberClosedSimpleProduct(state, guid) {
    const receipts = (state.simpleProductCompleted ??= [])
    if (!receipts.includes(guid)) receipts.push(guid)
    if (receipts.length > 256) receipts.splice(0, receipts.length - 256)
}
export function simpleProductionDue(state, now) {
    return (state.simpleProducts ?? []).some((job) => completed(job, now) > credited(job) || credited(job) >= job.count)
}
export function simpleProductSnapshot(state) {
    return {
        products: (state.simpleProducts ?? []).map((job) => {
            const done = job.reportedDone ?? credited(job),
                remaining = job.count - done,
                start = job.start + done * job.seconds
            return {
                product_guid: job.guid,
                product_id: job.productId,
                start_time: start,
                total_count: remaining,
                finish_time: start + job.seconds,
            }
        }),
    }
}
export function settleSimpleProducts(tables, state, now) {
    const rewards = [],
        dels = [],
        kept = []
    let changed = false
    for (const job of state.simpleProducts ?? []) {
        const done = completed(job, now),
            paid = credited(job),
            quantity = done - paid
        ensure(
            Number.isInteger(paid) && paid >= 0 && paid <= job.count,
            'Invalid quick-production receipt',
            ErrorCode.GameConfig,
        )
        if (quantity > 0) {
            const granted = grantRewards(tables, state, multiplied(job.rewards, quantity))
            rewards.push(...granted)
            recordSimpleProducts(state, granted)
            job.credited = done
            job.reportedDone = done
            changed = true
        }
        if (done >= job.count) {
            dels.push(job.guid)
            rememberClosedSimpleProduct(state, job.guid)
            changed = true
        } else kept.push(job)
    }
    if (dels.length) state.simpleProducts = kept
    return { changed, rewards, dels }
}
export function recordSimpleProducts(state, rewards) {
    const produced = (state.simpleProduced ??= {})
    for (const reward of rewards) {
        const key = `${reward.itemtype}:${reward.itemid}`,
            next = (produced[key] ?? 0) + reward.itemnum
        ensure(Number.isSafeInteger(next) && next <= 0xffffffff, 'Production progress overflow')
        produced[key] = next
    }
}
export function multiplySimpleRows(rows, count) {
    return multiplied(rows, count)
}
