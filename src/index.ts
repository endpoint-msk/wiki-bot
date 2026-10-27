import { collectMissed, keyOf } from './backfill.js'
import { Feed, type Incoming } from './feed.js'
import { Outline } from './outline.js'
import { startServer } from './server.js'
import { State } from './state.js'
import { Telegram } from './telegram.js'

try {
    process.loadEnvFile()
} catch {
    // No .env: in Docker the variables come from env_file.
}

const required = (name: string): string => {
    const v = process.env[name]
    if (!v) {
        console.error(`Не задана переменная окружения ${name}. См. .env.example.`)
        process.exit(1)
    }
    return v
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

const outlineUrl = trimSlash(required('OUTLINE_URL'))
const outline = new Outline(trimSlash(process.env.OUTLINE_API_URL || outlineUrl), required('OUTLINE_API_KEY'))
const feed = new Feed(outline, outlineUrl, process.env.PRIVATE_COLLECTIONS === 'post')
const telegram = new Telegram(
    trimSlash(process.env.TELEGRAM_API_URL || 'https://api.telegram.org'),
    required('BOT_TOKEN'),
    required('CHANNEL_ID'),
)
const secret = required('WEBHOOK_SECRET')
const state = new State(process.env.STATE_FILE || './data/state.json')
const backfillLimit = Number(process.env.BACKFILL_LIMIT || 30)

const handle = async (e: Incoming): Promise<void> => {
    const id = e.payload?.id
    if (!e.event || !id) {
        console.warn('[feed] событие без id, пропуск', e.event)
        return
    }
    const tag = `${e.event} ${id}`
    try {
        const out = await feed.render(e)
        if ('skip' in out) {
            console.log(`[feed] ${tag}: пропуск, ${out.skip}`)
        } else {
            await telegram.send(out.text)
            console.log(`[feed] ${tag}: в канале`)
        }
    } catch (err) {
        console.error(`[feed] ${tag}: ошибка`, err)
    }
    state.markSeen(keyOf(e.event, id), e.createdAt)
}

// One lane for everything, so the channel keeps the order in which things happened.
let lane: Promise<void> = Promise.resolve()
const enqueue = (job: () => Promise<void>) => {
    lane = lane.then(job, job)
}

const backfill = async () => {
    if (!state.cursor) {
        state.cursor = new Date().toISOString()
        await state.save()
        console.log('[backfill] первый запуск, догружать нечего')
        return
    }
    try {
        const { items, dropped } = await collectMissed(outline, state, backfillLimit)
        console.log(`[backfill] с ${state.cursor}: ${items.length} событий, отброшено ${dropped}`)
        if (dropped) await telegram.send(`Бот был недоступен: ещё ${dropped} ранних изменений вики в канал не попали.`)
        for (const item of items) await handle(item)
    } catch (err) {
        console.error('[backfill] журнал событий недоступен, пропущенное не догружено', err)
    }
}

const main = async () => {
    await state.load()
    try {
        const me = await outline.call<{ user: { name: string; isAdmin?: boolean } }>('auth.info', {})
        console.log(`[outline] ключ пользователя ${me.user.name}`)
    } catch (err) {
        console.error('[outline] ключ не прошёл auth.info', err)
    }

    enqueue(backfill)
    const port = Number(process.env.PORT || 8080)
    const server = startServer({
        host: process.env.HOST || '0.0.0.0',
        port,
        secret,
        onEvent: (e) => {
            console.log(`[webhook] ${e.event} ${e.payload?.id ?? ''}`)
            enqueue(() => handle(e))
        },
    })
    console.log(`[webhook] слушаю :${port}/webhook`)

    let stopping = false
    const shutdown = async () => {
        if (stopping) return
        stopping = true
        server.close()
        await Promise.race([lane, new Promise((resolve) => setTimeout(resolve, 20_000))])
        await state.save()
        process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
}

void main()
