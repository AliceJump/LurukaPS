import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ErrorCode } from '../src/error-codes.js'
import { createEggs } from '../src/eggs.js'
import { grantRewards } from '../src/rewards.js'
import { cookingRecipe } from '../src/cooking.js'
import { TaskGraphs, acceptAvailableSideTasks } from '../src/tasks.js'
import { trialSoulEssence } from '../src/trial-equipment.js'
import { worldCondition } from '../src/handlers/world-objects.js'
import { GrowupSystem } from '../src/growup.js'
import { arenaExecutionState } from '../src/npc-kibo-execution-properties.js'
import { ensurePetName } from '../src/pets.js'
import { addHeroFavorability } from '../src/home-dorm.js'

const tables = new Tables(configuration().tables)
const failsWith = (fn, code) => assert.throws(fn, (error) => error.code === code)

test('missing records differ from malformed fields in existing pet and favorability configurations', () => {
    failsWith(() => ensurePetName({ find: () => undefined }, { config_id: 1 }), ErrorCode.PetConfNotExist)
    failsWith(() => ensurePetName({}, {}, { name: '' }), ErrorCode.GameConfig)
    const missingLevel = { get: () => [{ favorabilityLevel: 1, favorabilityExp: 10 }] }
    failsWith(() => addHeroFavorability(missingLevel, { favorability_lv: 0 }, 1), ErrorCode.HeroFavorConfNone)
    const badValue = {
        get: () => [
            { favorabilityLevel: 0, favorabilityExp: 0 },
            { favorabilityLevel: 1, favorabilityExp: 10 },
        ],
    }
    failsWith(() => addHeroFavorability(badValue, { favorability_lv: 0 }, 1), ErrorCode.GameConfig)
})

test('missing egg, essence, saddle and task graphs use their own client error definitions', () => {
    failsWith(() => createEggs(tables, {}, 0xffffffff, 1), ErrorCode.EggConfNotExist)
    failsWith(
        () => grantRewards(tables, {}, [{ itemtype: 9, itemid: 0xffffffff, itemnum: 1 }]),
        ErrorCode.SoulEssenceConfNotExist,
    )
    failsWith(
        () => grantRewards(tables, {}, [{ itemtype: 25, itemid: 0xffffffff, itemnum: 1 }]),
        ErrorCode.MountSaddleConfNotFound,
    )
    failsWith(
        () => new TaskGraphs(tables, path.resolve('../work/no-such-task-graphs')).get(106010),
        ErrorCode.TaskConfFail,
    )
})

test('unavailable cooking recipes are business configuration failures, not invalid protocol IDs', () => {
    failsWith(() => cookingRecipe(tables, 0xffffffff), ErrorCode.CookConfFail)
    const row = tables.get('products_multi_quality')[0]
    const withoutMaterialGroups = Object.create(tables)
    withoutMaterialGroups.find = (name, id) => (name === 'food_material_group' ? undefined : tables.find(name, id))
    failsWith(() => cookingRecipe(withoutMaterialGroups, row.id), ErrorCode.CookMaterialConfFail)
})

test('malformed trial triples retain GameConfig while missing referenced essence uses the specific code', () => {
    failsWith(() => trialSoulEssence(tables, { soulessence: 'bad' }), ErrorCode.GameConfig)
    failsWith(() => trialSoulEssence(tables, { soulessence: '4294967295|0|1' }), ErrorCode.SoulEssenceConfNotExist)
})

test('GM task batch skips specifically missing graphs instead of aborting the entire batch', () => {
    const state = { tasks: [], taskRecords: [] }
    const small = { get: () => [{ id: 42, type: 2 }] }
    const graphs = {
        get: () => {
            const error = new Error('missing')
            error.code = ErrorCode.TaskConfFail
            throw error
        },
    }
    assert.doesNotThrow(() => acceptAvailableSideTasks(small, state, 1, graphs))
    assert.deepEqual(state.tasks, [])
})

test('a missing cultivation ending differs from an unmet ending condition', () => {
    const system = new GrowupSystem({ get: () => [] })
    failsWith(() => system.finish({}, 1, { ending: 2, trialId: 3 }), ErrorCode.CultInvalidEndId)
    system.tables = { get: () => [{ systemId: 1, endingId: 2, trial: 3, condition: 'blocked' }] }
    system.condition = () => false
    failsWith(() => system.finish({}, 1, { ending: 2, trialId: 3 }), ErrorCode.CultEndNotComplete)
})

test('unsupported condition capabilities and stale arena state do not claim corrupt configuration', () => {
    failsWith(() => worldCondition('99999#1', {}), ErrorCode.FunctionClosed)
    failsWith(
        () => arenaExecutionState({ state: { combat: {}, world: { map_id: 100 } } }, { status: 'ready' }),
        ErrorCode.InvalidLogic,
    )
})
