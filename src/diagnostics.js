import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const privateField =
    /^(open_?id|account|password|pwd|token|server_token|access_token|refresh_token|secret|accesskeysecret|authorization|signature|rc4_key|msg|message|command|args|name|sign|extra_info|product_id)$/i
export function redactRequest(value) {
    const seen = new WeakSet()
    let remaining = 500
    const visit = (input, depth = 0) => {
        if (--remaining < 0 || depth > 6) return '[truncated]'
        if (input === null || typeof input !== 'object')
            return typeof input === 'string' && input.length > 256 ? input.slice(0, 256) + '[truncated]' : input
        if (seen.has(input)) return '[circular]'
        seen.add(input)
        if (Array.isArray(input)) {
            const items = input.slice(0, 32).map((x) => visit(x, depth + 1))
            if (input.length > 32) items.push({ omitted: input.length - 32 })
            return items
        }
        return Object.fromEntries(
            Object.entries(input)
                .slice(0, 50)
                .map(([key, val]) => [key, privateField.test(key) ? '[redacted]' : visit(val, depth + 1)]),
        )
    }
    return visit(value)
}
export class ProtocolDiagnostics {
    constructor(filename, logger = console, { maxBytes = 4 * 1024 * 1024, maxEntryBytes = 32768 } = {}) {
        this.filename = filename
        this.logger = logger
        this.maxBytes = maxBytes
        this.maxEntryBytes = maxEntryBytes
        this.disabled = !filename
        this.startedAt = new Date().toISOString()
    }
    record({ phase = 'dispatch', protocol, frame, accountId, error, receivedBytes, replayHigh, connection }) {
        if (this.disabled) return
        try {
            const definition = frame && protocol?.byId.get(frame.id)
            let request
            if (frame && definition?.req) {
                try {
                    request = redactRequest(protocol.decode(definition.req, frame.payload))
                } catch {
                    request = { decode_failed: true }
                }
            }
            const entry = {
                time: new Date().toISOString(),
                server_started_at: this.startedAt,
                phase,
                account_id: accountId ?? null,
                message_id: frame?.id ?? null,
                protocol: definition?.name ?? null,
                sequence: frame?.seq ?? null,
                error_code: Number.isInteger(error?.code) ? error.code : null,
                error: String(error?.message ?? error).slice(0, 2048),
                payload_bytes: frame?.payload?.length ?? receivedBytes ?? 0,
                payload_sha256: frame?.payload ? createHash('sha256').update(frame.payload).digest('hex') : undefined,
                request,
            }
            if (error?.arenaSpContext) entry.arena_sp = redactRequest(error.arenaSpContext)
            if (phase === 'framing') {
                entry.replay_high = replayHigh ?? null
                if (connection) entry.connection = redactRequest(connection)
            }
            let line = JSON.stringify(entry) + '\n'
            if (Buffer.byteLength(line) > this.maxEntryBytes) {
                entry.request = { omitted: 'entry size limit' }
                line = JSON.stringify(entry) + '\n'
            }
            fs.mkdirSync(path.dirname(this.filename), { recursive: true })
            const size = fs.existsSync(this.filename) ? fs.statSync(this.filename).size : 0
            if (size + Buffer.byteLength(line) > this.maxBytes) {
                this.disabled = true
                this.logger.warn('Protocol diagnostic log is full; archive it and restart to resume capture.')
                return
            }
            fs.appendFileSync(this.filename, line, 'utf8')
        } catch (err) {
            this.disabled = true
            this.logger.warn(`Protocol diagnostics disabled: ${err.code ?? err.message}`)
        }
    }
}
