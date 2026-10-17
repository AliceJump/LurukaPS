import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { TaskGraphs, nodeConditions } from './tasks.js'
import { deliveryKey } from './task-delivery.js'
import { recordTaskBehaviour, virtualStateReportTarget } from './task-events.js'

const catalogs = new WeakMap()
export function recoverFailedSpecialNpcEvents(c, protocol, filename, records) {
    let graphs = catalogs.get(c.tables)
    if (!graphs) catalogs.set(c.tables, (graphs = new TaskGraphs(c.tables)))
    const candidates = []
    for (const task of c.state.tasks ?? [])
        for (const node of task.nodes) {
            if (!node.client_before) continue
            nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).forEach((condition, index) => {
                const base = condition.__type_TaskConditionBaseData,
                    signal = base?.__type_TaskCondSignalReceiverData,
                    virtualState = base?.__type_TaskCondWorldUnitVirtualStateData,
                    area = base?.__type_TaskCondAreaTriggerData,
                    data = signal ?? virtualState ?? area ?? base?.__type_TaskCondActiveSpecialNPCTriggerData
                const key = deliveryKey(c.state, task.task_id, node.node_id, index)
                if (condition.conditionId !== 2519 || !data || c.state.taskEvents?.[key]) return
                // TaskEntitySignalReceiver reports signalType, including 0,
                // rather than the task NPC's ID from mapData.targetId.
                const target = signal
                    ? data.signalType
                    : virtualState
                      ? virtualStateReportTarget(virtualState)
                      : data.isNowCreate
                        ? data.npcData?.createNpcId
                        : data.createNpcId
                if (!Number.isSafeInteger(target) || target < (signal || area ? 0 : 1) || target > 0xffffffff) return
                const request = { key: 2519, args: [target, task.task_id, node.node_id, index, 1] }
                const payload = protocol.encode(protocol.byId.get(9904).req, request)
                candidates.push({ task, key, request, hash: createHash('sha256').update(payload).digest('hex') })
            })
        }
    if (!candidates.length) return 0
    if (!records) {
        if (!filename) return 0
        try {
            if (fs.statSync(filename).size > 8 * 1024 * 1024) return 0
            records = fs
                .readFileSync(filename, 'utf8')
                .split(/\r?\n/)
                .flatMap((line) => {
                    try {
                        return [JSON.parse(line)]
                    } catch {
                        return []
                    }
                })
        } catch {
            return 0
        }
    }
    let recovered = 0
    for (const candidate of candidates) {
        const evidence = records.find(
            (record) =>
                record.phase === 'dispatch' &&
                record.account_id === c.id &&
                record.message_id === 9904 &&
                record.request?.key === 2519 &&
                record.error_code === ErrorCode.GameConfig &&
                String(record.error).startsWith('Task event configuration unavailable') &&
                record.payload_sha256 === candidate.hash &&
                Number.isFinite(Date.parse(record.time)) &&
                Date.parse(record.time) >= (candidate.task.start_time ?? Infinity) * 1000 &&
                Date.parse(record.time) <= c.now * 1000,
        )
        if (!evidence) continue
        // A hash match proves this exact configured interaction was already
        // sent and rejected. Apply its ordinary validator; never infer a clear
        // from proximity, an inactive node or a different account's log.
        try {
            recordTaskBehaviour({ ...c, push: () => {} }, candidate.request)
        } catch {
            continue
        }
        ;(c.state.taskEventRecoveries ??= {})[candidate.key] = {
            payload_sha256: candidate.hash,
            failed_at: evidence.time,
        }
        recovered++
    }
    return recovered
}
