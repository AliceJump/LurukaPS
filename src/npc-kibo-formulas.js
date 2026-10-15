import fs from 'node:fs'

const { formulas } = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-formulas.json', import.meta.url), 'utf8'))
const F = Math.fround

function roundEven(value) {
    const floor = Math.floor(value),
        fraction = value - floor
    return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}

function operator(a, b, op, zero) {
    switch (op) {
        case 0:
            return Number(a > b)
        case 1:
            return Number(a < b)
        case 2:
            return Number(a === b)
        case 3:
            return Number(a >= b)
        case 4:
            return Number(a <= b)
        case 5:
            return Number(a !== b)
        case 6:
            return F(a + b)
        case 7:
            return F(a - b)
        case 8:
            return F(a * b)
        case 9:
            if (b !== 0) return F(a / b)
            zero?.()
            return 0
        case 10:
            return F(a & b)
        case 11:
            return F(a | b)
        default:
            throw new Error(`Unsupported arena formula operator ${op}`)
    }
}

// InnerCalculate uses float stacks, eagerly evaluates IF arguments, and calls
// entity/snapshot services separately. Resolvers must return unprefixed native
// values with item.target/custom_int intact; missing inputs never become zero.
// This is the arithmetic foundation, not a complete damage/buff executor.
export function evaluateArenaFormula(id, context = {}) {
    const formula = formulas[id]
    if (!formula) throw new Error(`Unknown arena formula ${id}`)
    if (!formula.stack_valid) throw new Error(`Arena formula ${id}: invalid source stack`)
    const stack = []
    const pop = () => {
        if (!stack.length) throw new Error(`Arena formula ${id}: stack underflow`)
        return stack.pop()
    }
    const input = (resolver, ...args) => {
        const value = context[resolver]?.(...args)
        if (!Number.isFinite(value)) throw new Error(`Arena formula ${id}: missing or invalid ${resolver}`)
        return F(value)
    }
    for (const item of formula.items) {
        if (item.kind === 1) stack.push(F(input('entity', item) * F(item.prefix)))
        else if (item.kind === 3) {
            // IFormulaElement.FunctionParams may override parameters by skill
            // level. The resolver represents that lookup, not a guessed list.
            stack.push(F(input('parameter', item.operation) * F(item.prefix)))
        } else if (item.kind === 4) {
            const value = F(F(Number(BigInt(item.constant_q16))) / 65536)
            stack.push(item.filter ? F(Number(BigInt.asIntN(64, 1n << BigInt(Math.trunc(value) & 63)))) : value)
        } else if (item.kind === 2) {
            const b = pop(),
                a = pop()
            stack.push(operator(a, b, item.operation, () => context.onZeroDivision?.(id)))
        } else if (item.kind === 0) {
            let result
            switch (item.operation) {
                case 0: {
                    const no = pop(),
                        yes = pop(),
                        condition = pop()
                    result = condition > 0 ? yes : no
                    break
                }
                case 1: {
                    const b = pop()
                    result = Math.max(pop(), b)
                    break
                }
                case 2: {
                    const b = pop()
                    result = Math.min(pop(), b)
                    break
                }
                case 3: {
                    const b = pop()
                    result = Number(pop() > 0 && b > 0)
                    break
                }
                case 4: {
                    const b = pop()
                    result = Number(pop() > 0 || b > 0)
                    break
                }
                case 5:
                    result = input('random')
                    break
                case 6:
                    result = input('worldLevel')
                    break
                case 7:
                    result = Math.floor(pop())
                    break
                case 8:
                    // Native CEILING is RoundToInt(value + .5), including its
                    // unusual even-tie behavior. Do not replace with Math.ceil.
                    result = roundEven(F(pop() + F(0.5)))
                    break
                case 9:
                    result = roundEven(pop())
                    break
                case 10:
                    result = input('activityAttribute', roundEven(pop()))
                    break
                default:
                    throw new Error(`Unsupported arena formula function ${item.operation}`)
            }
            stack.push(F(result))
        } else throw new Error(`Unsupported arena formula item ${item.kind}`)
    }
    if (stack.length !== 1 || !Number.isFinite(stack[0])) throw new Error(`Arena formula ${id}: invalid result`)
    return stack[0]
}
