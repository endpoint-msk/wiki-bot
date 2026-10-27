const MIN_GAP_MS = 1_000
const MAX_ATTEMPTS = 6

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ApiReply = { ok: boolean; description?: string; parameters?: { retry_after?: number } }

export class Telegram {
    private lastSentAt = 0

    constructor(
        private readonly apiUrl: string,
        private readonly token: string,
        private readonly chatId: string,
    ) {}

    async send(text: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            const wait = this.lastSentAt + MIN_GAP_MS - Date.now()
            if (wait > 0) await sleep(wait)
            let res: Response
            try {
                res = await fetch(`${this.apiUrl}/bot${this.token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this.chatId,
                        text,
                        parse_mode: 'HTML',
                        // Links lead behind the SSO login, so a preview would only show its page.
                        link_preview_options: { is_disabled: true },
                    }),
                    signal: AbortSignal.timeout(20_000),
                })
            } catch (err) {
                if (attempt >= MAX_ATTEMPTS) throw err
                await sleep(2 ** attempt * 1_000)
                continue
            }
            this.lastSentAt = Date.now()
            const reply = (await res.json().catch(() => ({ ok: false }))) as ApiReply
            if (reply.ok) return
            if (res.status === 429) {
                await sleep((reply.parameters?.retry_after ?? 5) * 1_000)
                continue
            }
            if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
                await sleep(2 ** attempt * 1_000)
                continue
            }
            throw new Error(`sendMessage: HTTP ${res.status} ${reply.description ?? ''}`)
        }
    }
}
