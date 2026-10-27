import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Long enough to cover the overlap re-read on backfill after a restart.
const SEEN_TTL_MS = 60 * 60_000

type Saved = { cursor: string | null; seen: [string, number][] }

export class State {
    cursor: string | null = null
    private seen = new Map<string, number>()
    private saveTimer: NodeJS.Timeout | null = null

    constructor(private readonly file: string) {}

    async load(): Promise<void> {
        try {
            const saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved
            this.cursor = saved.cursor
            this.seen = new Map(saved.seen)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
    }

    hasSeen(key: string): boolean {
        const at = this.seen.get(key)
        return at !== undefined && Date.now() - at < SEEN_TTL_MS
    }

    markSeen(key: string, eventAt: string): void {
        this.seen.set(key, Date.now())
        if (!this.cursor || Date.parse(eventAt) > Date.parse(this.cursor)) this.cursor = eventAt
        this.scheduleSave()
    }

    private scheduleSave(): void {
        if (this.saveTimer) return
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            void this.save().catch((err) => console.error('[state] не сохранился', err))
        }, 1_000)
    }

    async save(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer)
            this.saveTimer = null
        }
        const now = Date.now()
        for (const [key, at] of this.seen) if (now - at > SEEN_TTL_MS) this.seen.delete(key)
        const data: Saved = { cursor: this.cursor, seen: [...this.seen] }
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(`${this.file}.tmp`, JSON.stringify(data))
        await rename(`${this.file}.tmp`, this.file)
    }
}
