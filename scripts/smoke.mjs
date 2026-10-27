// End-to-end check without a real Outline or Telegram: mocks both APIs, runs the bot,
// posts signed webhooks, restarts it and checks the backfill.
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'smoke-secret'
const PORT = 18_080
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const users = { u1: { id: 'u1', name: 'Аня <admin>' }, u2: { id: 'u2', name: 'Боря' } }
const collections = {
    pub: { id: 'pub', name: 'Хакспейс', url: '/collection/space-1', permission: 'read_write' },
    priv: { id: 'priv', name: 'Секреты', url: '/collection/secret-2', permission: null },
}
const docs = {
    a: { id: 'a', title: 'Правила & доступ', url: '/doc/rules-a1', collectionId: 'pub', parentDocumentId: null, publishedAt: ago(10 * 60_000) },
    draft: { id: 'draft', title: 'Черновик', url: '/doc/draft-d1', collectionId: 'pub', parentDocumentId: null, publishedAt: null },
    secret: { id: 'secret', title: 'Пароли', url: '/doc/pw-s1', collectionId: 'priv', parentDocumentId: null, publishedAt: ago(60 * 60_000) },
}
const revisions = {
    r0: { id: 'r0', documentId: 'a', title: 'Правила', text: 'раз\nдва\nтри', createdAt: docs.a.publishedAt, createdBy: users.u1 },
    r1: { id: 'r1', documentId: 'a', title: 'Правила & доступ', text: 'раз\nдва изменено\nтри\nчетыре\nпять', createdAt: ago(60_000), createdBy: users.u1, collaborators: [users.u1, users.u2] },
    r2: { id: 'r2', documentId: 'a', title: 'Правила & доступ', text: 'раз\nдва изменено\nтри\nчетыре\nпять\nшесть', createdAt: ago(0), createdBy: users.u2 },
    rd: { id: 'rd', documentId: 'draft', title: 'Черновик', text: 'x', createdAt: ago(0), createdBy: users.u1 },
}
let events = []
// Copied from outline/outline shared/utils/EventHelper.ts.
const ACTIVITY_EVENTS = new Set([
    'collections.create', 'collections.delete', 'collections.move', 'collections.permission_changed',
    'collections.add_user', 'collections.remove_user', 'documents.publish', 'documents.unpublish',
    'documents.archive', 'documents.unarchive', 'documents.move', 'documents.delete',
    'documents.permanent_delete', 'documents.restore', 'documents.add_user', 'documents.remove_user',
    'revisions.create', 'users.create', 'users.demote', 'userMemberships.update',
])

const listen = (handler) =>
    new Promise((resolve) => {
        const server = createServer(async (req, res) => {
            let raw = ''
            for await (const c of req) raw += c
            const out = await handler(req.url, raw ? JSON.parse(raw) : {})
            res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body))
        })
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
    })

const found = (v) => (v ? { body: { data: v } } : { status: 404, body: { ok: false } })
const outline = await listen((url, body) => {
    switch (url) {
        case '/api/auth.info': return { body: { data: { user: users.u1 } } }
        case '/api/users.info': return found(users[body.id])
        case '/api/collections.info': return found(collections[body.id])
        case '/api/documents.info': return found(docs[body.id])
        case '/api/revisions.info': return found(revisions[body.id])
        // Like the real route: no body in list items.
        case '/api/revisions.list':
            return found(
                Object.values(revisions)
                    .filter((r) => r.documentId === body.documentId)
                    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                    .map(({ text, ...rest }) => rest),
            )
        // Like the real schema: names outside ACTIVITY_EVENTS fail validation.
        case '/api/events.list':
            if (!(body.events ?? []).every((n) => ACTIVITY_EVENTS.has(n))) return { status: 400, body: { ok: false, error: 'validation_error' } }
            return found(events.slice(body.offset, body.offset + body.limit))
        default: return { status: 404, body: {} }
    }
})

const sent = []
const telegram = await listen((url, body) => {
    if (!url.endsWith('/sendMessage')) return { status: 404, body: { ok: false } }
    sent.push(body)
    return { body: { ok: true, result: {} } }
})

const dataDir = await mkdtemp(join(tmpdir(), 'wiki-bot-smoke-'))
const env = {
    ...process.env,
    BOT_TOKEN: '1:test',
    CHANNEL_ID: '-100',
    OUTLINE_URL: 'https://wiki.test',
    OUTLINE_API_URL: outline.url,
    OUTLINE_API_KEY: 'ol_api_test',
    WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_URL: telegram.url,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    STATE_FILE: join(dataDir, 'state.json'),
}

let bot
const startBot = async () => {
    bot = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    bot.stdout.on('data', (d) => process.stdout.write(`  bot| ${d}`))
    bot.stderr.on('data', (d) => process.stdout.write(`  bot! ${d}`))
    for (let i = 0; i < 100; i++) {
        if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false)) return
        await sleep(100)
    }
    throw new Error('bot did not start')
}
const stopBot = async () => {
    const exited = new Promise((r) => bot.once('exit', r))
    bot.kill('SIGTERM')
    await exited
}

const post = (body, secret = SECRET) => {
    const raw = JSON.stringify(body)
    const t = Date.now()
    const s = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
    return fetch(`http://127.0.0.1:${PORT}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Outline-Signature': `t=${t},s=${s}` },
        body: raw,
    }).then((r) => r.status)
}
const hook = (event, id, model, actorId = 'u1') => ({ id: `d-${Math.random()}`, actorId, webhookSubscriptionId: 'w', event, createdAt: new Date().toISOString(), payload: { id, model } })

const failures = []
const check = (name, ok) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) failures.push(name)
}

try {
    await startBot()
    check('bad signature is rejected', (await post(hook('documents.publish', 'a', docs.a), 'wrong')) === 401)

    const statuses = [
        await post(hook('documents.publish', 'a', docs.a)),
        await post(hook('revisions.create', 'r0', revisions.r0)),
        await post(hook('revisions.create', 'r1', revisions.r1)),
        await post(hook('revisions.create', 'rd', revisions.rd)),
        await post(hook('documents.archive', 'secret', docs.secret)),
        await post(hook('collections.create', 'priv', collections.priv)),
        await post(hook('documents.move', 'a', { ...docs.a, parentDocumentId: 'a' }, 'u2')),
    ]
    check('webhooks acknowledged with 200', statuses.every((s) => s === 200))
    await sleep(4_000)

    check('three posts after live webhooks', sent.length === 3)
    check('publish announced once', sent.filter((m) => m.text.startsWith('<b>Опубликован</b>')).length === 1)
    const edit = sent.find((m) => m.text.startsWith('<b>Правка</b>'))?.text ?? ''
    check('edit has diff counts', edit.includes('+3 −1'))
    check('edit shows rename', edit.includes('было «Правила»'))
    check('edit links revision history', edit.includes('https://wiki.test/doc/rules-a1/history/r1'))
    check('names are escaped', edit.includes('Аня &lt;admin&gt;, Боря') && edit.includes('Правила &amp; доступ'))
    check('draft and private stay out', !sent.some((m) => /Черновик|Пароли|Секреты/.test(m.text)))
    check('move names destination', sent.some((m) => m.text.startsWith('<b>Перемещён</b>') && m.text.includes('Хакспейс › ')))
    check('link previews disabled', sent.every((m) => m.link_preview_options?.is_disabled === true))

    await sleep(1_500)
    await stopBot()
    // While the bot is down: one new edit and one already delivered event land in the audit trail.
    events = [
        { id: 'e2', name: 'revisions.create', modelId: 'r2', actorId: 'u2', documentId: 'a', collectionId: 'pub', createdAt: revisions.r2.createdAt },
        { id: 'e1', name: 'revisions.create', modelId: 'r1', actorId: 'u1', documentId: 'a', collectionId: 'pub', createdAt: revisions.r1.createdAt },
    ]
    revisions.r2.createdAt = new Date(Date.now() + 1_000).toISOString()
    events[0].createdAt = revisions.r2.createdAt
    const before = sent.length
    await startBot()
    await sleep(3_000)
    const backfilled = sent.slice(before)
    check('backfill posts only the missed edit', backfilled.length === 1 && backfilled[0].text.includes('history/r2') && backfilled[0].text.includes('+1 −0'))
    await stopBot()
} finally {
    if (bot && bot.exitCode === null) bot.kill()
    outline.server.close()
    telegram.server.close()
    await rm(dataDir, { recursive: true, force: true })
}

console.log('\n--- posts ---\n' + sent.map((m) => m.text).join('\n\n'))
if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
}
console.log('\nall checks passed')
