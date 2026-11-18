import { describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveEntryId, ArchiveFormat, EntryAccess, EntryByteAccess, EntryDownloadReport, ListUpdate } from "@filen/sdk-rs"
import { createArchiveReaders, READ_AHEAD_IDLE_MS, type ReaderLike, type ReaderOpenRequest } from "@/workers/archiveReaders"
import { entryCost, entryReadPlan, extractsToRead, SOLID_BLOCK_READ_MAX_BYTES } from "@/features/archive/lib/entryAccess.logic"
import { READ_AHEAD_MAX_ENTRIES, readAheadBudget } from "@/lib/sdk/archiveListing"
import { storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

// The worker's archive readers against a model of the SDK's: what each call fetches of the archive, so a run of entries
// read one after another (a comic's pages) can be measured against the archive's own size; and the reader's lifetime
// (close with calls in flight, a shared opening, waiters on a read under way, the read-ahead's budget).

const KiB = 1024
const MiB = 1024 * KiB
const PAGES = 50
// The SDK's checkpoint spacing in a gzip stream's output.
const CHECKPOINT = 4 * MiB
// What every reader may hold read ahead on a desktop browser.
const BUDGET = readAheadBudget(undefined)

const ARCHIVE = { uuid: TEST_ARCHIVE, size: 1n } as unknown as AnyFile

function idOf(index: number): ArchiveEntryId {
	return { archive: TEST_ARCHIVE, index }
}

// Real comic pages: 2 to 5 MiB each, packed to 90 % of that.
const SIZES = Array.from({ length: PAGES }, (_, i) => 2 * MiB + ((i * 7919) % 31) * Math.floor((3 * MiB) / 30))
const PACKED = SIZES.map(size => Math.round(size * 0.9))
const OFFSETS = SIZES.map((_, i) => SIZES.slice(0, i).reduce((sum, size) => sum + size, 0))
const PACKED_ENDS = PACKED.map((_, i) => PACKED.slice(0, i + 1).reduce((sum, size) => sum + size, 0))
const LINEAR = PACKED_ENDS.at(-1) ?? 0

function size(index: number): number {
	return SIZES[index] ?? 0
}

function solidAccess(i: number): EntryAccess {
	return {
		type: "solidBlock",
		skippedBytes: BigInt(OFFSETS[i] ?? 0),
		estimatedPackedBytes: BigInt(PACKED_ENDS[i] ?? 0),
		blockPackedBytes: BigInt(LINEAR)
	}
}

// A listing of PAGES pages in one solid block, as the SDK lists a solid .cbr's members and a .tar.gz's.
function solidListing() {
	return storeOf(
		Array.from({ length: PAGES }, (_, i) => ({ path: `p${String(i + 1)}.jpg`, index: i, size: size(i), access: solidAccess(i) }))
	)
}

async function fill(writer: WritableStream<Uint8Array>, bytes: number): Promise<void> {
	const w = writer.getWriter()

	await w.write(new Uint8Array(bytes))
	await w.close()
}

const DONE: EntryDownloadReport = { bytesWritten: 0n, bytesRead: 0n, checked: true, error: undefined }
const EMPTY_PASS = { entries: 0n, bytesWritten: 0n, bytesRead: 0n, checked: true, error: undefined }

// The SDK's reader as far as cost goes. A solid RAR (`sequential`): every pass decodes the block from its start. A gzip
// tar (`seekable`): one decoder over the tar's stream goes on from where it stopped, else from the last checkpoint at or
// before the read.
function modelReader(kind: "solidRar" | "gzipTar") {
	const cost = { fetched: 0, passes: 0, downloads: 0, ranges: 0 }
	let cursor = 0
	let decodedTo = 0
	const format: ArchiveFormat = kind === "solidRar" ? { type: "rar", version: "rar50Plus" } : { type: "tar", codec: "gzip" }

	const reader = {
		format,
		entryByteAccess: (entry: ArchiveEntryId): Promise<EntryByteAccess> =>
			Promise.resolve(
				kind === "solidRar"
					? { type: "sequential", size: BigInt(size(entry.index)) }
					: { type: "seekable", size: BigInt(size(entry.index)) }
			),
		downloadEntry: vi.fn(
			async (params: { entry: ArchiveEntryId; writer: WritableStream<Uint8Array> }): Promise<EntryDownloadReport> => {
				cost.downloads += 1
				cost.fetched += PACKED_ENDS[params.entry.index] ?? 0
				await fill(params.writer, size(params.entry.index))

				return DONE
			}
		),
		readEntries: vi.fn(
			async (params: {
				entries: ArchiveEntryId[]
				writerFor: (entry: ArchiveEntryId, size: bigint | undefined) => WritableStream<Uint8Array> | undefined
				maxSolidSkip: bigint | number | null
				managedFuture?: { abortSignal?: AbortSignal }
			}) => {
				const indexes = params.entries.map(entry => entry.index).sort((a, b) => a - b)
				const first = indexes[0] ?? 0
				const last = indexes.at(-1) ?? 0

				cost.passes += 1
				// What the pass throws away: everything the block stores before its first entry.
				expect(OFFSETS[first] ?? 0).toBeLessThanOrEqual(Number(params.maxSolidSkip))
				cost.fetched += PACKED_ENDS[last] ?? 0

				for (const index of indexes) {
					const writer = params.writerFor(idOf(index), BigInt(size(index)))

					if (writer !== undefined) {
						await fill(writer, size(index))
					}
				}

				return { ...EMPTY_PASS, entries: BigInt(indexes.length) }
			}
		),
		readEntryRange: vi.fn(
			async (params: { entry: ArchiveEntryId; start: bigint | number; end: bigint | number; writer: WritableStream<Uint8Array> }) => {
				const from = (OFFSETS[params.entry.index] ?? 0) + Number(params.start)
				const to = (OFFSETS[params.entry.index] ?? 0) + Number(params.end)
				// On from the cursor, else from the checkpoint before the read (laid as the output passed it).
				const start =
					from >= cursor
						? cursor
						: Math.min(Math.floor(from / CHECKPOINT) * CHECKPOINT, Math.floor(decodedTo / CHECKPOINT) * CHECKPOINT)

				cost.ranges += 1
				cost.fetched += (to - start) * 0.9
				cursor = to
				decodedTo = Math.max(decodedTo, to)
				await fill(params.writer, to - from)
			}
		),
		list: vi.fn(),
		close: vi.fn(),
		free: vi.fn()
	}

	return { reader, asReader: reader as unknown as ReaderLike, cost }
}

type Model = ReturnType<typeof modelReader>

function readersOver(model: Model, release: () => void = vi.fn()) {
	const opens: ReaderOpenRequest[] = []
	const readers = createArchiveReaders({
		open: request => {
			opens.push(request)

			return Promise.resolve({ reader: model.asReader, release })
		},
		aheadBudget: () => BUDGET
	})

	readers.register("r", ARCHIVE, false, undefined)

	return { readers, opens }
}

const EVENTS = { phase: () => undefined, verified: () => undefined, failed: () => undefined }

function readPage(readers: ReturnType<typeof readersOver>["readers"], index: number, signal = new AbortController().signal, id = "r") {
	return readers.readWhole(id, idOf(index), size(index), entryReadPlan(solidListing(), index, true, BUDGET), EVENTS, signal)
}

describe("archive readers: what 50 sequential pages of 2 to 5 MiB fetch, once the cost was accepted", () => {
	it("reads a solid .cbr's pages in passes of a read-ahead window: a few times the archive, never once per page", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)

		for (let index = 0; index < PAGES; index++) {
			expect((await readPage(readers, index)).length).toBe(size(index))
		}

		// The window is bounded by the read-ahead budget (24 MiB): five to eleven pages a pass.
		expect(model.cost.passes).toBeGreaterThanOrEqual(Math.ceil(PAGES / (READ_AHEAD_MAX_ENTRIES + 1)))
		expect(model.cost.passes).toBeLessThan(PAGES / 4)
		expect(model.cost.downloads).toBe(0)
		// Each pass decodes from the block's start: about four times the archive in all.
		expect(model.cost.fetched / LINEAR).toBeLessThan(5)
		expect(model.cost.fetched / LINEAR).toBeGreaterThan(2.5)
	})

	it("reads a .tar.gz's members through range reads that decode on from the last one: the archive once", async () => {
		const model = modelReader("gzipTar")
		const { readers } = readersOver(model)

		for (let index = 0; index < PAGES; index++) {
			await readPage(readers, index)
		}

		expect(model.cost.ranges).toBe(PAGES)
		expect(model.cost.passes).toBe(0)
		expect(Math.round(model.cost.fetched)).toBe(Math.round(((OFFSETS.at(-1) ?? 0) + size(PAGES - 1)) * 0.9))
	})
})

describe("archive readers: read-ahead", () => {
	it("serves a page a running pass is writing from that pass, not a second decode", async () => {
		const model = modelReader("solidRar")
		const { readers, opens } = readersOver(model)
		const [first, second] = await Promise.all([readPage(readers, 0), readPage(readers, 1)])

		expect(first.length).toBe(size(0))
		expect(second.length).toBe(size(1))
		expect(model.cost.passes).toBe(1)
		expect(opens).toHaveLength(1)
	})

	it("reads again once, by the first waiter, after the read it waited for failed", async () => {
		const model = modelReader("solidRar")

		model.reader.readEntries.mockRejectedValueOnce(new Error("network"))

		const { readers } = readersOver(model)
		const results = await Promise.allSettled([readPage(readers, 0), readPage(readers, 1), readPage(readers, 2)])

		expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
		// The failed one, and one more by the first waiter, which brought the other.
		expect(model.reader.readEntries).toHaveBeenCalledTimes(2)
	})

	it("shares one read of an entry asked twice at once, each caller with its own buffer", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)
		const [first, second] = await Promise.all([readPage(readers, 4), readPage(readers, 4)])

		expect(model.cost.passes).toBe(1)
		expect(first.length).toBe(size(4))
		expect(second.length).toBe(size(4))
		expect(second.buffer === first.buffer).toBe(false)
	})

	it("after a failed pass lets the earliest waiter lead, whose pass the later ones join; no two passes run at once", async () => {
		const model = modelReader("solidRar")
		const firstIndexes: number[] = []
		let running = 0
		let most = 0
		const pass = model.reader.readEntries.getMockImplementation()

		model.reader.readEntries.mockImplementation(async params => {
			running += 1
			most = Math.max(most, running)
			firstIndexes.push(Math.min(...params.entries.map(entry => entry.index)))

			try {
				if (firstIndexes.length === 1) {
					await Promise.resolve()

					throw new Error("network")
				}

				return await (pass?.(params) ?? Promise.resolve(EMPTY_PASS))
			} finally {
				running -= 1
			}
		})

		const { readers } = readersOver(model)
		// The leader at page 0; then waiters on pages 3 and 1, the later page asking first.
		const results = await Promise.allSettled([readPage(readers, 0), readPage(readers, 3), readPage(readers, 1)])

		expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
		expect(firstIndexes).toEqual([0, 1])
		expect(most).toBe(1)
	})

	it("keeps what is held ahead and what a pass brings within the budget together, during the pass", async () => {
		const model = modelReader("solidRar")
		const small = 12 * MiB
		const readers = createArchiveReaders({
			open: () => Promise.resolve({ reader: model.asReader, release: vi.fn() }),
			aheadBudget: () => small
		})
		const store = solidListing()
		const signal = new AbortController().signal
		const pass = model.reader.readEntries.getMockImplementation()
		const peaks: number[] = []

		model.reader.readEntries.mockImplementation(params => {
			const asked = params.entries[0]?.index ?? 0
			const coming = params.entries.filter(entry => entry.index !== asked).reduce((sum, entry) => sum + size(entry.index), 0)

			peaks.push(readers.heldBytes("a") + readers.heldBytes("b") + coming)

			return pass?.(params) ?? Promise.resolve(EMPTY_PASS)
		})
		readers.register("a", ARCHIVE, false, undefined)
		readers.register("b", ARCHIVE, false, "pw")
		await readers.readWhole("a", idOf(0), size(0), entryReadPlan(store, 0, true, small), EVENTS, signal)
		await readers.readWhole("b", idOf(20), size(20), entryReadPlan(store, 20, true, small), EVENTS, signal)
		await readers.readWhole("a", idOf(30), size(30), entryReadPlan(store, 30, true, small), EVENTS, signal)

		expect(peaks).toHaveLength(3)
		for (const peak of peaks) {
			expect(peak).toBeLessThanOrEqual(small)
		}
	})

	it("lets a waiter leave by its own cancel", async () => {
		const model = modelReader("solidRar")
		const hold = Promise.withResolvers<undefined>()

		model.reader.readEntries.mockImplementationOnce(async () => {
			await hold.promise

			return EMPTY_PASS
		})

		const { readers } = readersOver(model)
		const leaving = new AbortController()
		const first = readPage(readers, 0)
		const waiter = readPage(readers, 1, leaving.signal)

		leaving.abort(new Error("left"))
		await expect(waiter).rejects.toThrow("left")
		hold.resolve(undefined)
		await expect(first).rejects.toThrow("ended before its entry")
	})

	it("marks no file for a gzip tar's range read, which brings only its own", async () => {
		const model = modelReader("gzipTar")
		const { readers } = readersOver(model)

		await Promise.all([readPage(readers, 0), readPage(readers, 1)])

		expect(model.cost.ranges).toBe(2)
	})

	it("holds what every reader read ahead within one budget, oldest dropped first", async () => {
		const model = modelReader("solidRar")
		const small = 8 * MiB
		const readers = createArchiveReaders({
			open: () => Promise.resolve({ reader: model.asReader, release: vi.fn() }),
			aheadBudget: () => small
		})
		const store = solidListing()
		const signal = new AbortController().signal

		readers.register("a", ARCHIVE, false, undefined)
		readers.register("b", ARCHIVE, false, "pw")
		await readers.readWhole("a", idOf(0), size(0), entryReadPlan(store, 0, true, small), EVENTS, signal)
		expect(readers.heldBytes("a")).toBeGreaterThan(0)
		await readers.readWhole("b", idOf(10), size(10), entryReadPlan(store, 10, true, small), EVENTS, signal)

		expect(readers.heldBytes("a") + readers.heldBytes("b")).toBeLessThanOrEqual(small)
		expect(readers.heldBytes("b")).toBeGreaterThan(0)
	})

	it("gives up what it read ahead a while after its last lease, and saves from it before", async () => {
		const model = modelReader("solidRar")
		const idle: (() => void)[] = []
		const readers = createArchiveReaders({
			open: () => Promise.resolve({ reader: model.asReader, release: vi.fn() }),
			aheadBudget: () => BUDGET,
			setTimer: (run, ms) => {
				expect(ms).toBe(READ_AHEAD_IDLE_MS)
				idle.push(run)

				return () => {
					idle.splice(idle.indexOf(run), 1)
				}
			}
		})

		readers.register("r", ARCHIVE, false, undefined)
		readers.lease("r")
		await readPage(readers, 0)

		// A save of a page read ahead writes what is held: no decode.
		const saved: number[] = []

		await readers.download(
			"r",
			idOf(1),
			new WritableStream({
				write: chunk => {
					saved.push(chunk.length)
				}
			}),
			0,
			() => undefined,
			{}
		)
		expect(saved).toEqual([size(1)])
		expect(model.reader.downloadEntry).not.toHaveBeenCalled()

		readers.unlease("r")
		expect(readers.heldBytes("r")).toBeGreaterThan(0)
		for (const run of idle.splice(0)) {
			run()
		}
		expect(readers.heldBytes("r")).toBe(0)
	})
})

describe("archive readers: range reads", () => {
	it("reads a range of an entry through the reader, and tells its access once", async () => {
		const model = modelReader("gzipTar")
		const { readers } = readersOver(model)
		const signal = new AbortController().signal

		expect((await readers.readRange("r", idOf(2), 10, 110, signal)).length).toBe(100)
		await expect(readers.byteAccess("r", idOf(2), signal)).resolves.toBe("seekable")
		await expect(readers.byteAccess("r", idOf(2), signal)).resolves.toBe("seekable")
		expect(model.reader.readEntryRange).toHaveBeenCalledTimes(1)
	})
})

describe("archive readers: lifetime", () => {
	it("closes with a call in flight: aborts it, never throws, and frees only once it settled", async () => {
		const model = modelReader("solidRar")
		const hold = Promise.withResolvers<undefined>()
		let seen: AbortSignal | undefined

		model.reader.readEntries.mockImplementationOnce(async params => {
			seen = params.managedFuture?.abortSignal
			await hold.promise

			return { ...EMPTY_PASS, checked: false }
		})

		// wasm-bindgen refuses to free a value a pending call borrows: a release then would throw.
		let pending = true
		const release = vi.fn(() => {
			if (pending) {
				throw new Error("attempted to take ownership of Rust value while it was borrowed")
			}
		})
		const { readers } = readersOver(model, release)
		const read = readPage(readers, 3)

		await vi.waitFor(() => {
			expect(seen).toBeDefined()
		})
		expect(() => {
			readers.clear()
		}).not.toThrow()
		expect(seen?.aborted).toBe(true)
		expect(model.reader.close).toHaveBeenCalledTimes(1)
		expect(release).not.toHaveBeenCalled()

		pending = false
		hold.resolve(undefined)
		await expect(read).rejects.toThrow()
		expect(release).toHaveBeenCalledTimes(1)
		await expect(readPage(readers, 3)).rejects.toMatchObject({ name: "Cancelled" })
	})

	it("shuts an opening every waiter left that resolves after a newer one: the newer reader is the one kept", async () => {
		const stale = modelReader("solidRar")
		const fresh = modelReader("solidRar")
		const openings = [
			Promise.withResolvers<{ reader: ReaderLike; release: () => void }>(),
			Promise.withResolvers<{ reader: ReaderLike; release: () => void }>()
		]
		const releases = [vi.fn(), vi.fn()]
		let opened = 0
		const readers = createArchiveReaders({
			open: () => (openings[opened++] ?? openings[1])?.promise ?? Promise.reject(new Error("no opening")),
			aheadBudget: () => BUDGET
		})

		readers.register("r", ARCHIVE, false, undefined)

		const leaving = new AbortController()
		const first = readers.list("r", null, () => undefined, { abortSignal: leaving.signal })

		await vi.waitFor(() => {
			expect(opened).toBe(1)
		})
		leaving.abort(new Error("left"))
		await expect(first).rejects.toThrow("left")

		const second = readers.list("r", null, () => undefined, { abortSignal: new AbortController().signal })

		await vi.waitFor(() => {
			expect(opened).toBe(2)
		})
		fresh.reader.list.mockResolvedValue({})
		openings[1]?.resolve({ reader: fresh.asReader, release: releases[1] ?? vi.fn() })
		await expect(second).resolves.toBeDefined()
		// The SDK finished the first before it saw the cancel.
		openings[0]?.resolve({ reader: stale.asReader, release: releases[0] ?? vi.fn() })
		await vi.waitFor(() => {
			expect(releases[0]).toHaveBeenCalledTimes(1)
		})
		expect(stale.reader.close).toHaveBeenCalledTimes(1)
		expect(fresh.reader.close).not.toHaveBeenCalled()
		await readers.list("r", null, () => undefined, { abortSignal: new AbortController().signal })
		expect(fresh.reader.list).toHaveBeenCalledTimes(2)
	})

	it("shares one opening among its waiters: one leaving cancels nothing for the rest, and each hears its progress", async () => {
		const model = modelReader("solidRar")
		const opened = Promise.withResolvers<{ reader: ReaderLike; release: () => void }>()
		const requests: ReaderOpenRequest[] = []
		const readers = createArchiveReaders({
			open: request => {
				requests.push(request)

				return opened.promise
			},
			aheadBudget: () => BUDGET
		})

		readers.register("r", ARCHIVE, false, undefined)

		const leaving = new AbortController()
		const heard: string[] = []
		const first = readers.list("r", null, () => heard.push("first"), { abortSignal: leaving.signal })
		const second = readers.list("r", null, () => heard.push("second"), { abortSignal: new AbortController().signal })

		await vi.waitFor(() => {
			expect(requests).toHaveLength(1)
		})
		requests[0]?.onUpdate({ phase: "reading" } as ListUpdate)
		expect(heard).toEqual(["first", "second"])

		leaving.abort(new Error("left"))
		await expect(first).rejects.toThrow("left")
		expect(requests[0]?.managedFuture.abortSignal?.aborted).toBe(false)

		model.reader.list.mockResolvedValue({})
		opened.resolve({ reader: model.asReader, release: vi.fn() })
		await expect(second).resolves.toBeDefined()
	})
})

describe("read plans", () => {
	const solid = (skipped: number, block: number): EntryAccess => ({
		type: "solidBlock",
		skippedBytes: BigInt(skipped),
		estimatedPackedBytes: BigInt(skipped + 10),
		blockPackedBytes: BigInt(block)
	})

	it("reads nothing ahead before the session accepted a cost", () => {
		expect(entryReadPlan(solidListing(), 0, false, BUDGET).window).toHaveLength(1)
	})

	it("ends a window at the next block, even one whose first file and this one's both skip nothing", () => {
		const store = storeOf([
			{ path: "a", index: 0, size: 10, access: solid(0, 100) },
			{ path: "b", index: 1, size: 10, access: solid(0, 100) },
			{ path: "c", index: 2, size: 10, access: solid(10, 200) }
		])

		expect(entryReadPlan(store, 0, true, BUDGET).window.map(item => item.index)).toEqual([0])
		expect(entryReadPlan(store, 1, true, BUDGET).window.map(item => item.index)).toEqual([1])
	})

	it("bounds the pass's skip by the entry's own and what lies between the window's files", () => {
		const store = storeOf([
			{ path: "a", index: 0, size: 10, access: solid(0, 100) },
			{ path: "b", index: 1, size: 10, access: solid(10, 100) },
			// 5 bytes of a left-out entry before it.
			{ path: "c", index: 3, size: 10, access: solid(25, 100) }
		])

		expect(entryReadPlan(store, 1, true, BUDGET)).toEqual({
			maxSolidSkip: 10,
			window: [
				{ index: 1, size: 10 },
				{ index: 3, size: 10 }
			],
			windowSkip: 15
		})
	})

	it("states what the window fetches, and sends a file of a block above 512 MiB to extracting", () => {
		const store = storeOf([
			{ path: "a", index: 0, size: 10, access: solid(0, 100) },
			{ path: "b", index: 1, size: 10, access: solid(10, 100) },
			{ path: "c", index: 2, size: 10, access: solid(20, 100) },
			{ path: "huge", index: 3, size: 10, access: solid(10, SOLID_BLOCK_READ_MAX_BYTES + 1) }
		])

		expect(entryCost(store, 1)?.estimatedBytes).toBe(20)
		expect(entryCost(store, 1, entryReadPlan(store, 1, true, BUDGET))?.estimatedBytes).toBe(30)
		expect(extractsToRead(store, 1)).toBe(false)
		expect(extractsToRead(store, 3)).toBe(true)
	})

	it("keeps a window within the read-ahead budget", () => {
		const plan = entryReadPlan(solidListing(), 0, true, BUDGET)

		expect(plan.window.slice(1).reduce((sum, item) => sum + item.size, 0)).toBeLessThanOrEqual(BUDGET)
		expect(plan.window.length).toBeLessThanOrEqual(READ_AHEAD_MAX_ENTRIES + 1)
	})
})
