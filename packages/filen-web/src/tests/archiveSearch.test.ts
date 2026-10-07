import { describe, expect, it, vi } from "vitest"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { createEntrySearch, searchEntries, SEARCH_CAP } from "@/features/archive/lib/search"
import { dirOfRef, isDirRef } from "@/features/archive/lib/sortedChildren"
import { createEntryStore } from "@/features/archive/lib/entryStore"
import { packEntries, storeOf } from "@/tests/support/archiveEntries"

function labels(store: EntryStore, refs: Int32Array): string[] {
	return Array.from(refs, ref => (isDirRef(ref) ? `${store.dirPath(dirOfRef(ref))}/` : store.name(ref)))
}

describe("searchEntries", () => {
	const store = storeOf([
		"docs/Report 10.pdf",
		"docs/report 2.pdf",
		"docs/reports/",
		"docs/reports/q1.xlsx",
		"other/report.txt",
		"a+b (1).txt",
		"a+b (2).txt",
		"ab.txt",
		{ path: undefined, stored: "../report.sh", skip: "unsafePath" }
	])

	it("matches case-insensitively, directories first, then by name", async () => {
		const result = await searchEntries(store, 0, "REPORT")

		expect(labels(store, result.refs)).toEqual(["docs/reports/", "../report.sh", "report 2.pdf", "Report 10.pdf", "report.txt"])
		expect(result.truncated).toBe(false)
	})

	it("takes the query literally", async () => {
		expect(labels(store, (await searchEntries(store, 0, "a+b (1)")).refs)).toEqual(["a+b (1).txt"])
		expect((await searchEntries(store, 0, ".*")).refs).toHaveLength(0)
		expect((await searchEntries(store, 0, "[")).refs).toHaveLength(0)
	})

	it("searches below the scope directory only, at any depth", async () => {
		const docs = store.findDir("docs")

		expect(labels(store, (await searchEntries(store, docs, ".")).refs)).toEqual(["q1.xlsx", "report 2.pdf", "Report 10.pdf"])
		expect(labels(store, (await searchEntries(store, docs, "report")).refs)).toEqual(["docs/reports/", "report 2.pdf", "Report 10.pdf"])
		expect(labels(store, (await searchEntries(store, store.findDir("docs/reports"), "report")).refs)).toEqual([])
	})

	it("stops at the cap and says so", async () => {
		const many = storeOf(Array.from({ length: SEARCH_CAP + 5 }, (_, i) => `match ${String(i)}`))
		const capped = await searchEntries(many, 0, "match")

		expect(capped.refs).toHaveLength(SEARCH_CAP)
		expect(capped.truncated).toBe(true)

		const exact = await searchEntries(many, 0, "match", { cap: SEARCH_CAP + 5 })

		expect(exact.refs).toHaveLength(SEARCH_CAP + 5)
		expect(exact.truncated).toBe(false)
	})

	it("yields to the event loop every yieldEvery items", async () => {
		const big = storeOf(Array.from({ length: 100 }, (_, i) => `n${String(i)}`))
		const timeouts = vi.spyOn(globalThis, "setTimeout")
		const result = await searchEntries(big, 0, "n9", { yieldEvery: 10 })

		expect(timeouts).toHaveBeenCalledTimes(10)
		expect(labels(big, result.refs)).toEqual(["n9", "n90", "n91", "n92", "n93", "n94", "n95", "n96", "n97", "n98", "n99"])
	})

	it("stops at the next yield once aborted", async () => {
		const big = storeOf(Array.from({ length: 100 }, (_, i) => `n${String(i)}`))
		const controller = new AbortController()
		const search = searchEntries(big, 0, "n", { yieldEvery: 10, signal: controller.signal })

		controller.abort()

		await expect(search).rejects.toThrow()
	})

	it("rejects at once when already aborted", async () => {
		await expect(searchEntries(store, 0, "x", { signal: AbortSignal.abort() })).rejects.toThrow()
	})

	it("scans 250k names reading each once, walking ancestry only for matches", async () => {
		const total = 250_000
		const big = storeOf(["d0/x", "d1/x"])

		big.append({
			archive: big.archiveUuid,
			count: total,
			index: Uint32Array.from({ length: total }, (_, i) => i + 2),
			kind: new Uint8Array(total),
			skip: new Uint8Array(total),
			flags: new Uint8Array(total),
			size: new Float64Array(total).fill(1),
			modified: new Float64Array(total).fill(NaN),
			name: Array.from({ length: total }, (_, i) => `photo ${String(i)}.jpg`),
			parent: new Uint32Array(total),
			parents: [""],
			links: [],
			stored: [],
			solid: null
		})

		// Counts the reads rather than timing them, which a loaded machine would fail.
		let nameReads = 0
		let parentReads = 0
		const counted: EntryStore = {
			...big,
			name: slot => {
				nameReads++

				return big.name(slot)
			},
			parent: slot => {
				parentReads++

				return big.parent(slot)
			}
		}
		const d0 = big.findDir("d0")
		const matches = 11
		const result = await searchEntries(counted, d0, "photo 12345", { yieldEvery: total * 2 })

		expect(result.refs).toHaveLength(0)
		expect(parentReads).toBe(matches)
		// The final sort of no results reads nothing more.
		expect(nameReads).toBe(big.entryCount)

		const scoped = await searchEntries(counted, 0, "photo 12345", { yieldEvery: total * 2 })

		expect(labels(big, scoped.refs)).toEqual([
			"photo 12345.jpg",
			...Array.from({ length: 10 }, (_, i) => `photo ${String(123450 + i)}.jpg`)
		])
		expect(scoped.refs).toHaveLength(matches)
	})
})

describe("createEntrySearch", () => {
	// A store a listing streams into, batch by batch, the slots whose names were read recorded.
	function streaming(paths: string[], flushAt: number) {
		const store = createEntryStore()
		const batches = packEntries(paths, flushAt)
		const name = vi.spyOn(store, "name")

		return {
			store,
			read: () => name.mock.calls.map(([slot]) => slot),
			next: () => {
				const batch = batches.shift()

				if (batch === undefined) {
					throw new Error("no batch left")
				}

				store.append(batch)
			}
		}
	}

	const PATHS = Array.from({ length: 40 }, (_, i) => `${i % 4 === 0 ? "sub/" : ""}file ${String(39 - i)}${i % 3 === 0 ? " hit" : ""}`)

	it("scans only what arrived since, merging the new matches into order", async () => {
		const stream = streaming(PATHS, 10)
		const search = createEntrySearch(stream.store, 0, "hit")

		stream.next()

		const first = await search.advance()
		const before = stream.read().length

		stream.next()
		stream.next()
		stream.next()

		const all = await search.advance()
		const matched = new Set(first.refs)

		// No name of the first batch is read again, but for the matches the merge orders.
		expect(
			stream
				.read()
				.slice(before)
				.filter(slot => slot < 10 && !matched.has(slot))
		).toEqual([])
		expect(first.refs.length).toBeLessThan(all.refs.length)
		expect(labels(stream.store, all.refs)).toEqual(labels(stream.store, (await searchEntries(stream.store, 0, "hit")).refs))
	})

	it("hands back the same answer when nothing new matched", async () => {
		const stream = streaming(["a hit", "b", "c"], 1)
		const search = createEntrySearch(stream.store, 0, "hit")

		stream.next()

		const first = await search.advance()

		stream.next()

		expect(await search.advance()).toBe(first)
	})

	it("goes on from where an aborted scan stopped, keeping what it found", async () => {
		const store = storeOf(Array.from({ length: 100 }, (_, i) => `n${String(i)}`))
		const search = createEntrySearch(store, 0, "n9", { yieldEvery: 10 })
		const controller = new AbortController()
		const aborted = search.advance(controller.signal)

		controller.abort()

		await expect(aborted).rejects.toThrow()

		const result = await search.advance()

		expect(labels(store, result.refs)).toEqual(["n9", "n90", "n91", "n92", "n93", "n94", "n95", "n96", "n97", "n98", "n99"])
	})

	it("keeps the cap across scans, then scans no more", async () => {
		const stream = streaming(
			Array.from({ length: 30 }, (_, i) => `match ${String(i)}`),
			10
		)
		const search = createEntrySearch(stream.store, 0, "match", { cap: 15 })

		stream.next()

		expect(await search.advance()).toMatchObject({ truncated: false })

		stream.next()

		const capped = await search.advance()

		expect(capped.refs).toHaveLength(15)
		expect(capped.truncated).toBe(true)

		stream.next()

		const reads = stream.read().length

		expect(await search.advance()).toBe(capped)
		expect(stream.read()).toHaveLength(reads)
	})
})
