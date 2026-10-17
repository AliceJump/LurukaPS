import { ErrorCode } from '../error-codes.js'
import { ensureHome } from '../home.js'
import { spend } from '../inventory.js'
import { refreshProduction } from '../production.js'
import { productionSeconds } from '../production-time.js'
import { ensure } from './common.js'
import { cookingRecipe, cookingMaterials } from '../cooking.js'
import { homeCondition } from '../home-grid.js'

export function registerCooking(on, tables) {
    on('CookRequest', (c, r) => {
        const home = ensureHome(tables, c.state)
        const homeMapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        ensure(c.state.world.map_id === homeMapId, 'Cooking requires the home scene')
        const recipe = cookingRecipe(tables, r.cook_id),
            product = recipe.product
        const build = home.builds.find((entry) => entry.guid === r.build_guid)
        ensure(build && [1, 4].includes(build.status), 'Cooking/processing station is not owned or placed')
        const station = tables.find('home_building_production', build.build_id)
        ensure(
            product &&
                station &&
                String(product.group).split('|').map(Number).includes(station.groupId) &&
                product.rewardId === `3#${r.cook_id}#1` &&
                Number.isInteger(product.time) &&
                product.time > 0,
            'Cooking queue configuration is missing',
            ErrorCode.GameConfig,
        )
        ensure(!product.notReleased && homeCondition(product.unlockCondition, c.state), 'Cooking recipe locked')
        ensure(
            Number.isInteger(r.cook_count) && r.cook_count > 0 && r.cook_count <= product.numberLimit,
            'Invalid cooking quantity',
        )
        const supplied = cookingMaterials(recipe, r.cook_material)
        // cook_material describes one serving. cook_count multiplies the bag
        // cost server-side; the CBT3 client sends 4 wheat for 1, 2 and 4 pies.
        const costs = new Map()
        for (const [id, perServing] of supplied) {
            const count = perServing * r.cook_count
            ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Cooking material overflow')
            costs.set(id, count)
        }
        home.productionJobs ??= {}
        const jobs = home.productionJobs[build.guid] || []
        ensure(
            Number.isInteger(station.productionQueueNum) &&
                station.productionQueueNum > 0 &&
                jobs.length < station.productionQueueNum,
            'Cooking queue is full',
        )
        const seconds = productionSeconds(tables, c.state, build, product)
        const start = Math.max(c.now, ...jobs.map((job) => job.start + job.count * job.seconds))
        ensure(start + r.cook_count * seconds <= 0xffffffff, 'Cooking finish time overflow')
        const guid = home.nextProductGuid || 1
        ensure(guid <= 0xffffffff, 'Cooking job identity exhausted')
        spend(c.state, costs, 0, c.now)
        home.nextProductGuid = guid + 1
        jobs.push({
            kind: 'cook',
            guid,
            productId: product.id,
            count: r.cook_count,
            claimed: 0,
            start,
            seconds,
            costs: [...supplied].map(([itemid, itemnum]) => ({ itemtype: 3, itemid, itemnum })),
            rewards: [{ itemtype: 3, itemid: r.cook_id, itemnum: 1 }],
            reportedDone: 0,
        })
        home.productionJobs[build.guid] = jobs
        refreshProduction(c.state, c.now)
        return { rewards: [] }
    })
}
