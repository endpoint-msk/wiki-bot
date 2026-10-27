// Above this many cells the exact LCS table gets too slow for a webhook handler.
const MAX_CELLS = 4_000_000

const toLines = (text: string): string[] =>
    text
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim())

const lcsLength = (a: string[], b: string[]): number => {
    let prev = new Int32Array(b.length + 1)
    let cur = new Int32Array(b.length + 1)
    for (const line of a) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = line === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!)
        }
        ;[prev, cur] = [cur, prev]
    }
    return prev[b.length]!
}

const multisetOverlap = (a: string[], b: string[]): number => {
    const counts = new Map<string, number>()
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
    let common = 0
    for (const line of b) {
        const left = counts.get(line)
        if (left) {
            counts.set(line, left - 1)
            common++
        }
    }
    return common
}

export const lineDiff = (before: string, after: string): { added: number; removed: number } => {
    const a = toLines(before)
    const b = toLines(after)
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let end = 0
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    const x = a.slice(start, a.length - end)
    const y = b.slice(start, b.length - end)
    const common = x.length * y.length > MAX_CELLS ? multisetOverlap(x, y) : lcsLength(x, y)
    return { added: y.length - common, removed: x.length - common }
}
