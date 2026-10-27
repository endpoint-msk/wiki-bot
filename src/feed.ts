import { lineDiff } from './diff.js'
import type { Collection, Document, Outline, Revision, User } from './outline.js'

/** The webhook body as Outline posts it; backfilled events are rebuilt into the same shape. */
export type Incoming = {
    event: string
    actorId: string
    createdAt: string
    payload: { id: string; model: Record<string, unknown> | null }
}

export type Rendered = { text: string } | { skip: string }

const DOCUMENT_LABELS: Record<string, string> = {
    'documents.publish': 'Опубликован',
    'documents.unpublish': 'Снят с публикации',
    'documents.archive': 'В архиве',
    'documents.unarchive': 'Возвращён из архива',
    'documents.delete': 'В корзине',
    'documents.restore': 'Восстановлен',
    'documents.permanent_delete': 'Удалён навсегда',
    'documents.move': 'Перемещён',
}

const COLLECTION_LABELS: Record<string, string> = {
    'collections.create': 'Новая коллекция',
    'collections.update': 'Коллекция изменена',
    'collections.delete': 'Коллекция удалена',
    'collections.archive': 'Коллекция в архиве',
    'collections.restore': 'Коллекция восстановлена',
}

export const FEED_EVENTS = ['revisions.create', ...Object.keys(DOCUMENT_LABELS), ...Object.keys(COLLECTION_LABELS)]

// Publishing also snapshots the document into a revision; that revision is the publish itself.
const PUBLISH_SNAPSHOT_MS = 60_000
const ANNOUNCE_TTL_MS = 10 * 60_000

export const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const titleOf = (s: string | undefined): string => clip(s?.trim() || 'Без названия')
const link = (href: string, text: string): string => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`

const names = (users: (User | undefined)[]): string =>
    [...new Set(users.map((u) => u?.name).filter((n): n is string => !!n))].join(', ')

export class Feed {
    private announced = new Map<string, number>()

    constructor(
        private readonly outline: Outline,
        private readonly publicUrl: string,
        private readonly includePrivate: boolean,
    ) {}

    render(e: Incoming): Promise<Rendered> {
        if (e.event === 'revisions.create') return this.revision(e)
        if (e.event in DOCUMENT_LABELS) return this.document(e)
        if (e.event in COLLECTION_LABELS) return this.collection(e)
        return Promise.resolve({ skip: 'не отслеживается' })
    }

    private url(path: string): string {
        return `${this.publicUrl}${path}`
    }

    private async visibleCollection(id: string | null | undefined): Promise<Collection | string> {
        if (!id) return 'вне коллекции'
        const collection = await this.outline.collection(id)
        if (!collection) return 'коллекция недоступна ключу'
        if (collection.permission == null && !this.includePrivate) return 'приватная коллекция'
        return collection
    }

    private async actorName(id: string, fallback?: User): Promise<string> {
        const user = await this.outline.user(id).catch(() => null)
        return user?.name ?? fallback?.name ?? 'кто-то'
    }

    private announce(doc: Document, collection: Collection, who: string): Rendered {
        const at = this.announced.get(doc.id)
        if (at && Date.now() - at < ANNOUNCE_TTL_MS) return { skip: 'публикация уже в канале' }
        this.announced.set(doc.id, Date.now())
        for (const [id, t] of this.announced) if (Date.now() - t > ANNOUNCE_TTL_MS) this.announced.delete(id)
        return {
            text: [
                `<b>Опубликован</b> · ${link(this.url(doc.url), titleOf(doc.title))}`,
                [escapeHtml(collection.name), escapeHtml(who)].filter(Boolean).join(' · '),
            ].join('\n'),
        }
    }

    private async revision(e: Incoming): Promise<Rendered> {
        const rev = e.payload.model as Revision | null
        if (!rev?.documentId) return { skip: 'ревизия не найдена' }
        const doc = await this.outline.document(rev.documentId)
        if (!doc) return { skip: 'документ недоступен ключу' }
        if (!doc.publishedAt) return { skip: 'черновик' }
        const collection = await this.visibleCollection(doc.collectionId)
        if (typeof collection === 'string') return { skip: collection }

        const authors = names(rev.collaborators?.length ? rev.collaborators : [rev.createdBy])
        const sincePublish = Date.parse(rev.createdAt) - Date.parse(doc.publishedAt)
        // Only reachable through backfill: edits made while the document was still a draft.
        if (sincePublish < -PUBLISH_SNAPSHOT_MS) return { skip: 'правка черновика' }
        const fromPublish = sincePublish < PUBLISH_SNAPSHOT_MS
        const prev = fromPublish ? null : await this.outline.previousRevision(rev)
        if (!prev) return this.announce(doc, collection, authors)

        const { added, removed } = lineDiff(prev.text ?? '', rev.text ?? '')
        const renamed = titleOf(prev.title) !== titleOf(rev.title)
        const meta = [escapeHtml(collection.name)]
        if (authors) meta.push(escapeHtml(authors))
        if (added || removed) meta.push(`+${added} −${removed}`)
        else if (!renamed) meta.push('оформление')
        meta.push(link(this.url(`${doc.url}/history/${rev.id}`), 'что изменилось'))

        const lines = [`<b>Правка</b> · ${link(this.url(doc.url), titleOf(doc.title))}`]
        if (renamed) lines.push(`было «${escapeHtml(titleOf(prev.title))}»`)
        lines.push(meta.join(' · '))
        return { text: lines.join('\n') }
    }

    private async document(e: Incoming): Promise<Rendered> {
        const doc = e.payload.model as Document | null
        if (!doc) return { skip: 'документа больше нет' }
        if (!doc.publishedAt && e.event !== 'documents.unpublish') return { skip: 'черновик' }
        const collection = await this.visibleCollection(doc.collectionId)
        if (typeof collection === 'string') return { skip: collection }
        const who = await this.actorName(e.actorId, doc.updatedBy)
        if (e.event === 'documents.publish') return this.announce(doc, collection, who)

        let where = escapeHtml(collection.name)
        if (e.event === 'documents.move' && doc.parentDocumentId) {
            const parent = await this.outline.document(doc.parentDocumentId)
            if (parent) where += ` › ${escapeHtml(titleOf(parent.title))}`
        }
        const name = e.event === 'documents.permanent_delete' ? escapeHtml(titleOf(doc.title)) : link(this.url(doc.url), titleOf(doc.title))
        return { text: `<b>${DOCUMENT_LABELS[e.event]}</b> · ${name}\n${where} · ${escapeHtml(who)}` }
    }

    private async collection(e: Incoming): Promise<Rendered> {
        const collection = e.payload.model as Collection | null
        if (!collection?.id) return { skip: 'коллекции больше нет' }
        this.outline.forgetCollection(collection.id)
        if (collection.permission == null && !this.includePrivate) return { skip: 'приватная коллекция' }
        const who = await this.actorName(e.actorId)
        const name =
            collection.url && e.event !== 'collections.delete'
                ? link(this.url(collection.url), collection.name)
                : escapeHtml(collection.name)
        return { text: `<b>${COLLECTION_LABELS[e.event]}</b> · ${name}\n${escapeHtml(who)}` }
    }
}
