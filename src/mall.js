import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime, refreshWindow } from './shops.js'
export class MallCatalog {
    constructor(tables) {
        this.tables = tables
        this.shops = new Map(tables.get('mall_shop').map((x) => [x.shopId, x]))
        this.pay = new Map(tables.get('mall_pay_goods').map((x) => [x.goodsId, x]))
        this.diamond = new Map(tables.get('mall_goods').map((x) => [x.goodsId, x]))
    }
    goods(isPay, id, state, now) {
        const row = (isPay ? this.pay : this.diamond).get(id)
        ensure(row, 'Unknown mall goods')
        let start = 0,
            end = 0
        if (row.timelimit) {
            const time = this.tables.find('common_timelimit', row.timelimit)
            ensure(time, 'Missing mall schedule', ErrorCode.GameConfig)
            start = configTime(time.startTime)
            end = configTime(time.endTime)
        }
        const period = this.window(row, now)
        const record = state.mall?.purchases?.[`${isPay ? 'pay' : 'diamond'}:${id}`],
            count = record?.period === period.start ? record.count : 0
        const ids = [],
            progress = [],
            checks = []
        for (const condition of String(row.commonCondition || '')
            .split('|')
            .filter(Boolean)) {
            const [kind, target] = condition.split('#').map(Number)
            ids.push(kind)
            let value = 0,
                known = true
            if (kind === 2004) value = state.player.basic_info.lv
            else if (kind === 2007)
                value = (state.taskRecords ?? []).some((r) => r.task_id === target && r.count > 0) ? target : 0
            else known = false
            progress.push(value)
            checks.push(known && value >= target)
        }
        return {
            is_pay_goods: isPay,
            goods_id: id,
            begin_time: String(start),
            end_time: String(end),
            curr_purchase_num: count,
            reset_time: String(period.end),
            unlock_cond_id: ids,
            unlock_progress: progress,
            is_all_cond_done: checks.every(Boolean),
        }
    }
    window(row, now) {
        let refreshTypeParam = row.refreshTypeParam
        if (row.refreshType === 4 && String(refreshTypeParam).includes('|')) {
            const parts = String(refreshTypeParam).split('|').map(Number)
            ensure(parts.length === 3 && parts.every(Number.isInteger), 'Invalid mall refresh time')
            refreshTypeParam = parts[0] * 10000 + parts[1] * 100 + parts[2]
        }
        return row.refreshType === 0 ? { start: 0, end: 0 } : refreshWindow({ ...row, refreshTypeParam }, now)
    }
    list(isPay, shopId, goodsId, state, now) {
        const catalog = isPay ? this.pay : this.diamond
        let ids
        if (shopId) {
            const shop = this.shops.get(shopId)
            ensure(shop, 'Unknown mall shop')
            ids = String(isPay ? shop.goodsListPurchase : shop.goodsList)
                .split('|')
                .filter(Boolean)
                .map(Number)
        } else ids = [...catalog.keys()]
        if (goodsId) {
            ensure(ids.includes(goodsId), 'Mall goods do not belong to shop')
            ids = [goodsId]
        }
        return ids.map((id) => this.goods(isPay, id, state, now))
    }
}
