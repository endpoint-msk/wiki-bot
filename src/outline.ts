export type User = { id: string; name: string }

export type Collection = {
    id: string
    name: string
    url?: string
    /** null means private: nobody gets access by default. */
    permission: string | null
}

export type Document = {
    id: string
    title: string
    /** Path such as /doc/title-AbC123, without the host. */
    url: string
    collectionId: string | null
    parentDocumentId: string | null
    publishedAt: string | null
    updatedBy?: User
}

export type Revision = {
    id: string
    documentId: string
    title: string
    text?: string
    createdAt: string
    createdBy?: User
    collaborators?: User[]
}

export type OutlineEvent = {
    id: string
    name: string
    modelId: string | null
    actorId: string
    documentId: string | null
    collectionId: string | null
    createdAt: string
}

export class OutlineError extends Error {
    constructor(
        readonly method: string,
        readonly status: number,
        body: string,
    ) {
        super(`${method}: HTTP ${status} ${body.slice(0, 200)}`)
    }
}

const CACHE_TTL_MS = 10 * 60_000

class TtlCache<T> {
    private entries = new Map<string, { at: number; value: T }>()

    async get(key: string, load: () => Promise<T>): Promise<T> {
        const hit = this.entries.get(key)
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
        const value = await load()
        this.entries.set(key, { at: Date.now(), value })
        return value
    }

    delete(key: string): void {
        this.entries.delete(key)
    }
}

/** Missing and forbidden look the same to the feed: the key's user cannot see it. */
const orNull = async <T>(load: Promise<T>): Promise<T | null> => {
    try {
        return await load
    } catch (err) {
        if (err instanceof OutlineError && [400, 403, 404].includes(err.status)) return null
        throw err
    }
}

export class Outline {
    private users = new TtlCache<User | null>()
    private collections = new TtlCache<Collection | null>()

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
    ) {}

    async call<T>(method: string, body: object): Promise<T> {
        const res = await fetch(`${this.baseUrl}/api/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new OutlineError(method, res.status, await res.text().catch(() => ''))
        return ((await res.json()) as { data: T }).data
    }

    user(id: string): Promise<User | null> {
        return this.users.get(id, () => orNull(this.call<User>('users.info', { id })))
    }

    collection(id: string): Promise<Collection | null> {
        return this.collections.get(id, () => orNull(this.call<Collection>('collections.info', { id })))
    }

    forgetCollection(id: string): void {
        this.collections.delete(id)
    }

    document(id: string): Promise<Document | null> {
        return orNull(this.call<Document>('documents.info', { id }))
    }

    revision(id: string): Promise<Revision | null> {
        return orNull(this.call<Revision>('revisions.info', { id }))
    }

    async previousRevision(rev: Revision): Promise<Revision | null> {
        // revisions.list omits text and content, so the body comes from revisions.info.
        const list = await this.call<Revision[]>('revisions.list', { documentId: rev.documentId, limit: 10 })
        const at = Date.parse(rev.createdAt)
        const prev = list.find((r) => r.id !== rev.id && Date.parse(r.createdAt) < at)
        return prev ? this.revision(prev.id) : null
    }

    events(names: string[], offset: number, limit: number): Promise<OutlineEvent[]> {
        return this.call<OutlineEvent[]>('events.list', { events: names, direction: 'DESC', offset, limit })
    }
}
