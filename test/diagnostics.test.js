import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { ProtocolDiagnostics, redactRequest } from '../src/diagnostics.js'
test('request diagnostics redact private fields and bound recursive data', () => {
    const source = {
        purchase_sdk_id: 2001,
        product_id: 'private',
        msg: 'private',
        nested: { server_token: 'secret', obj_id: 42 },
        items: Array.from({ length: 100 }, (_, i) => i),
    }
    const result = redactRequest(source)
    assert.equal(result.purchase_sdk_id, 2001)
    assert.equal(result.product_id, '[redacted]')
    assert.equal(result.nested.server_token, '[redacted]')
    assert.equal(result.nested.obj_id, 42)
    assert.equal(result.items.length, 33)
    assert.equal(source.product_id, 'private')
    const cycle = {}
    cycle.self = cycle
    assert.equal(redactRequest(cycle).self, '[circular]')
})
test('diagnostic size/write failures do not escape into request processing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-diag-')),
        warnings = []
    try {
        const file = path.join(dir, 'errors.jsonl'),
            log = new ProtocolDiagnostics(file, { warn: (x) => warnings.push(x) }, { maxBytes: 1200 })
        for (let i = 0; i < 10; i++) log.record({ phase: 'framing', error: Error('bad frame'), receivedBytes: 99 })
        assert(fs.statSync(file).size <= 1200)
        assert.equal(log.disabled, true)
        assert.equal(warnings.length, 1)
        const blocker = path.join(dir, 'file')
        fs.writeFileSync(blocker, 'x')
        const invalid = new ProtocolDiagnostics(path.join(blocker, 'errors'), { warn: (x) => warnings.push(x) })
        assert.doesNotThrow(() => invalid.record({ error: Error('x') }))
        assert.equal(invalid.disabled, true)
    } finally {
        assert(dir.startsWith(path.join(os.tmpdir(), 'azur-diag-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('rejected arena casts log energy and active-cast evidence with existing redaction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-diag-'))
    try {
        const file = path.join(dir, 'errors.jsonl'),
            log = new ProtocolDiagnostics(file),
            error = Object.assign(Error('Arena ultimate energy is insufficient'), {
                code: 1024,
                arenaSpContext: {
                    uuid: '1441153998177435649',
                    skill_id: 50004005,
                    available_milli: 0,
                    cost_milli: 510000,
                    source_type: 0,
                    active_cast: { origin: 'server', at: 1792079437800 },
                    token: 'private',
                },
            })
        log.record({ accountId: 1, error })
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.equal(entry.error_code, 1024)
        assert.equal(entry.arena_sp.cost_milli, 510000)
        assert.equal(entry.arena_sp.available_milli, 0)
        assert.equal(entry.arena_sp.active_cast.origin, 'server')
        assert.equal(entry.arena_sp.token, '[redacted]')
        assert.equal(error.arenaSpContext.token, 'private')
    } finally {
        assert(dir.startsWith(path.join(os.tmpdir(), 'azur-diag-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('connection routing preserves official catalog and CDN endpoints', () => {
    const source = fs.readFileSync(new URL('../../Frida/connect-azurjs.ts', import.meta.url), 'utf8'),
        match = source.match(/function rewriteDiscoveryUrl\(original: string\): string \| undefined \{[\s\S]*?\n\}/)
    assert(match)
    const code = match[0].replace('original: string', 'original').replace(': string | undefined', '')
    const context = { DISCOVERY_BASE: 'http://127.0.0.1:20001' }
    vm.createContext(context)
    vm.runInContext(code + ';this.rewrite=rewriteDiscoveryUrl;', context)
    assert.equal(
        context.rewrite('https://official/version/client/patchV1?x=1'),
        'http://127.0.0.1:20001/version/client/patchV1?x=1',
    )
    for (const url of [
        'https://official/version/client/getCdnV1',
        'https://official/version/client/cdntoken',
        'https://official/version/client/announceV1',
        'https://sdk.example/products',
    ])
        assert.equal(context.rewrite(url), undefined)
})
