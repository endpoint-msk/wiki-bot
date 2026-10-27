import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Incoming } from './feed.js'

// Payloads carry the full document as ProseMirror JSON plus markdown, so big pages are megabytes.
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60_000

class BodyTooLarge extends Error {}

/** Outline signs `${t}.${body}` with HMAC-SHA256 and sends `Outline-Signature: t=<ms>,s=<hex>`. */
export const verifySignature = (secret: string, header: string | undefined, raw: Buffer, now = Date.now()): boolean => {
    if (!header) return false
    const parts = new Map(
        header.split(',').map((part) => {
            const i = part.indexOf('=')
            return [part.slice(0, i).trim(), part.slice(i + 1).trim()] as const
        }),
    )
    const t = parts.get('t')
    const s = parts.get('s')
    if (!t || !s || !(Math.abs(now - Number(t)) <= MAX_CLOCK_SKEW_MS)) return false
    const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest()
    const got = Buffer.from(s, 'hex')
    return got.length === expected.length && timingSafeEqual(got, expected)
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
        chunks.push(chunk)
    }
    return Buffer.concat(chunks)
}

export const startServer = (opts: {
    host: string
    port: number
    secret: string
    onEvent: (e: Incoming) => void
}): Server => {
    const server = createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/healthz') {
                res.writeHead(200).end('ok')
                return
            }
            // Exact path only: Outline delivers with redirect: "error", a slash redirect would fail it.
            if (req.method !== 'POST' || req.url !== '/webhook') {
                res.writeHead(404).end()
                return
            }
            const raw = await readBody(req)
            const signature = req.headers['outline-signature']
            if (!verifySignature(opts.secret, Array.isArray(signature) ? signature[0] : signature, raw)) {
                console.warn('[webhook] отклонён: неверная подпись')
                res.writeHead(401).end()
                return
            }
            const body = JSON.parse(raw.toString('utf8')) as Incoming
            // Acknowledge before any work: Outline waits 5 s, never retries, and disables
            // the subscription once most recent deliveries have failed.
            res.writeHead(200).end('ok')
            opts.onEvent(body)
        } catch (err) {
            if (!res.headersSent) res.writeHead(err instanceof BodyTooLarge ? 413 : 400).end()
            console.error('[webhook] ошибка разбора', err)
        }
    })
    server.listen(opts.port, opts.host)
    return server
}
