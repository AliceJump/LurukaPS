import { ErrorCode } from '../error-codes.js'
import { grantRewards } from '../rewards.js'
export { addItems } from '../inventory.js'
import { ensure } from './common.js'
export function registerMail(on) {
    on('MailList', (c) => ({ mails: c.state.mail }))
    on('ReadMail', (c, r) => {
        const m = c.state.mail.find((m) => m.guid === r.u64)
        ensure(m, 'Mail not found')
        m.read = true
        return { u64: m.guid }
    })
    on('MailCollect', (c, r) => {
        const m = c.state.mail.find((m) => m.guid === r.u64)
        ensure(m, 'Mail not found')
        m.collect = !m.collect
        return {}
    })
    on('FetchMail', (c, r) => {
        const selected = c.state.mail.filter(
            (m) => (!r.u64 || r.u64 === '0' || m.guid === r.u64) && !m.fetch && (!m.effecttm || m.effecttm > c.now),
        )
        ensure(!r.u64 || r.u64 === '0' || selected.length, 'Mail unavailable')
        const rewards = []
        for (const m of selected) {
            rewards.push(
                ...grantRewards(
                    c.tables,
                    c.state,
                    (m.reward?.rewards || []).map((x) => ({ ...x, itemtype: x.itemtype ?? 3 })),
                ),
            )
            m.fetch = true
            m.read = true
        }
        c.push('CSProtoSyncPlayerData', c.state.player)
        c.push('CSProtoMailSync', { mails: selected })
        return { guids: selected.map((m) => m.guid), rewards: { rewards }, errcode: ErrorCode.Succ }
    })
    on('DelMail', (c, r) => {
        const selected = c.state.mail.filter(
            (m) =>
                (!r.u64 || r.u64 === '0' || m.guid === r.u64) &&
                m.read &&
                !m.collect &&
                (m.fetch || !m.reward?.rewards?.length),
        )
        ensure(!r.u64 || r.u64 === '0' || selected.length, 'Mail cannot be deleted')
        const ids = selected.map((m) => m.guid)
        c.state.mail = c.state.mail.filter((m) => !ids.includes(m.guid))
        return { u64s: ids }
    })
}
