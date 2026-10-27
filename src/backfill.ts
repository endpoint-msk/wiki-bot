import { FEED_EVENTS, type Incoming } from './feed.js'
import type { Outline, OutlineEvent } from './outline.js'
import type { State } from './state.js'

// events.list validates names against Outline's ACTIVITY_EVENTS and rejects the whole request
// on anything else; collection updates, archives and restores are not recorded there at all.
const ACTIVITY_EVENTS = new Set([
    'revisions.create',
    'documents.publish',
    'documents.unpublish',
    'documents.archive',
    'documents.unarchive',
    'documents.move',
    'documents.delete',
    'documents.permanent_delete',
    'documents.restore',
    'collections.create',
    'collections.delete',
])
const BACKFILL_EVENTS = FEED_EVENTS.filter((name) => ACTIVITY_EVENTS.has(name))

// Webhook timestamps are delivery times, a little later than the event itself.
const OVERLAP_MS = 5 * 60_000
const PAGE_SIZE = 100
const MAX_PAGES = 10

export const keyOf = (event: string, id: string): string => `${event}:${id}`

const subjectId = (ev: OutlineEvent): string | null => {
    if (ev.name.startsWith('revisions.')) return ev.modelId
    if (ev.name.startsWith('documents.')) return ev.documentId
    return ev.collectionId ?? ev.modelId
}

const loadModel = async (outline: Outline, ev: OutlineEvent, id: string): Promise<Record<string, unknown> | null> => {
    if (ev.name.startsWith('revisions.')) return outline.revision(id)
    if (ev.name.startsWith('documents.')) return outline.document(id)
    return outline.collection(id)
}

/**
 * Events from the audit trail that happened after the cursor but never reached the bot,
 * oldest first. Only the newest `limit` are rebuilt so a long outage does not flood the channel.
 */
export const collectMissed = async (
    outline: Outline,
    state: State,
    limit: number,
): Promise<{ items: Incoming[]; dropped: number }> => {
    if (!state.cursor) return { items: [], dropped: 0 }
    const since = Date.parse(state.cursor) - OVERLAP_MS
    const missed: OutlineEvent[] = []
    pages: for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await outline.events(BACKFILL_EVENTS,page * PAGE_SIZE, PAGE_SIZE)
        for (const ev of batch) {
            if (Date.parse(ev.createdAt) <= since) break pages
            const id = subjectId(ev)
            if (id && !state.hasSeen(keyOf(ev.name, id))) missed.push(ev)
        }
        if (batch.length < PAGE_SIZE) break
    }
    missed.reverse()

    const dropped = Math.max(0, missed.length - limit)
    const items: Incoming[] = []
    for (const ev of missed.slice(dropped)) {
        const id = subjectId(ev)!
        items.push({
            event: ev.name,
            actorId: ev.actorId,
            createdAt: ev.createdAt,
            payload: { id, model: await loadModel(outline, ev, id) },
        })
    }
    return { items, dropped }
}
