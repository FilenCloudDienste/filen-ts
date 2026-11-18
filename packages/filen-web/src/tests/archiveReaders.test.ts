import { describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveEntryId, ArchiveFormat, EntryAccess, EntryByteAccess, EntryDownloadReport, ListUpdate } from "@filen/sdk-rs"
import { createArchiveReaders, READ_AHEAD_IDLE_MS, type ReaderLike, type ReaderOpenRequest } from "@/workers/archiveReaders"
import { entryCost, entryReadPlan, extractsToRead, SOLID_BLOCK_READ_MAX_BYTES } from "@/features/archive/lib/entryAccess.logic"
import { READ_AHEAD_MAX_ENTRIES, READ_AHEAD_MIN_ENTRIES, readAheadBudget, readAheadEntries } from "@/lib/sdk/archiveListing"
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

// A comic's pages, packed to 90 % of their size, one after another in one solid block.
function shapeOf(sizes: readonly number[]) {
	const packed = sizes.map(size => Math.round(size * 0.9))
	const offsets = sizes.map((_, i) => sizes.slice(0, i).reduce((sum, size) => sum + size, 0))
	const packedEnds = packed.map((_, i) => packed.slice(0, i + 1).reduce((sum, size) => sum + size, 0))

	return { sizes, offsets, packedEnds, linear: packedEnds.at(-1) ?? 0 }
}

type Shape = ReturnType<typeof shapeOf>

// Real comic pages: 2 to 5 MiB each.
const SHAPE = shapeOf(Array.from({ length: PAGES }, (_, i) => 2 * MiB + ((i * 7919) % 31) * Math.floor((3 * MiB) / 30)))
const OFFSETS = SHAPE.offsets
const LINEAR = SHAPE.linear

function size(index: number, shape: Shape = SHAPE): number {
	return shape.sizes[index] ?? 0
}

function solidAccess(i: number, shape: Shape = SHAPE): EntryAccess {
	return {
		type: "solidBlock",
		skippedBytes: BigInt(shape.offsets[i] ?? 0),
		estimatedPackedBytes: BigInt(shape.packedEnds[i] ?? 0),
		blockPackedBytes: BigInt(shape.linear)
	}
}

// A listing of the shape's pages in one solid block, as the SDK lists a solid .cbr's members and a .tar.gz's.
function solidListing(shape: Shape = SHAPE) {
	return storeOf(
		shape.sizes.map((pageSize, i) => ({ path: `p${String(i + 1)}.jpg`, index: i, size: pageSize, access: solidAccess(i, shape) }))
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
function modelReader(kind: "solidRar" | "gzipTar", shape: Shape = SHAPE) {
	const { offsets: OFFSETS, packedEnds: PACKED_ENDS } = shape
	const size = (index: number): number => shape.sizes[index] ?? 0
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

function readersOver(model: Model, release: () => void = vi.fn(), budget = BUDGET) {
	const opens: ReaderOpenRequest[] = []
	const readers = createArchiveReaders({
		open: request => {
			opens.push(request)

			return Promise.resolve({ reader: model.asReader, release })
		},
		aheadBudget: () => budget
	})

	readers.register("r", ARCHIVE, false, undefined)

	return { readers, opens }
}

const EVENTS = { phase: () => undefined, verified: () => undefined, failed: () => undefined }

function readPage(readers: ReturnType<typeof readersOver>["readers"], index: number, signal = new AbortController().signal, id = "r") {
	return readers.readWhole(id, idOf(index), size(index), entryReadPlan(solidListing(), index, true, BUDGET), EVENTS, signal)
}

// A comic read through from its first page, each page turned forward: the window grows with the turns.
async function readThrough(readers: ReturnType<typeof readersOver>["readers"], shape: Shape, budget = BUDGET): Promise<void> {
	const store = solidListing(shape)

	for (let index = 0; index < shape.sizes.length; index++) {
		const plan = entryReadPlan(store, index, true, budget, readAheadEntries(index))

		expect((await readers.readWhole("r", idOf(index), size(index, shape), plan, EVENTS, new AbortController().signal)).length).toBe(
			size(index, shape)
		)
	}
}

// The same comic read from its last page to its first, each page turned back: the window grows with the turns and is
// planned back.
async function readBack(readers: ReturnType<typeof readersOver>["readers"], shape: Shape): Promise<void> {
	const store = solidListing(shape)
	const last = shape.sizes.length - 1

	for (let index = last; index >= 0; index--) {
		const plan = entryReadPlan(store, index, true, BUDGET, readAheadEntries(last - index), "back")

		expect((await readers.readWhole("r", idOf(index), size(index, shape), plan, EVENTS, new AbortController().signal)).length).toBe(
			size(index, shape)
		)
	}
}

describe("archive readers: what 50 sequential pages of 2 to 5 MiB fetch, once the cost was accepted", () => {
	it("reads a solid .cbr's pages in passes of a read-ahead window: a few times the archive, never once per page", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)

		for (let index = 0; index < PAGES; index++) {
			expect((await readPage(readers, index)).length).toBe(size(index))
		}

		// The window is bounded by the read-ahead budget (24 MiB): five to eleven pages a pass.
		expect(model.cost.passes).toBeGreaterThanOrEqual(Math.ceil(PAGES / (READ_AHEAD_MIN_ENTRIES + 1)))
		expect(model.cost.passes).toBeLessThan(PAGES / 4)
		expect(model.cost.downloads).toBe(0)
		// Each pass decodes from the block's start: about four times the archive in all.
		expect(model.cost.fetched / LINEAR).toBeLessThan(5)
		expect(model.cost.fetched / LINEAR).toBeGreaterThan(2.5)
	})

	it("reads big pages as often as the budget allows however many turns: the window grows only in pages", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)

		await readThrough(readers, SHAPE)

		// 2 to 5 MiB pages fill the 24 MiB budget after five to eleven: the window cannot grow past it.
		expect(model.cost.fetched / LINEAR).toBeLessThan(5)
	})

	it("reads a long solid comic of scanned pages through in about twice its size, its window growing with the turns", async () => {
		// 200 pages of 300 to 500 KiB (about 80 MiB): a typical scanned comic.
		const long = shapeOf(Array.from({ length: 200 }, (_, i) => 300 * KiB + ((i * 7919) % 101) * 2 * KiB))
		const model = modelReader("solidRar", long)
		const { readers } = readersOver(model)

		await readThrough(readers, long)

		const ratio = model.cost.fetched / long.linear

		// About 2.2 times in 4 passes; a window of 16 throughout fetches about 6.6 times the archive in 12.
		expect(model.cost.passes).toBeLessThanOrEqual(5)
		expect(ratio).toBeLessThan(2.5)
		expect(ratio).toBeGreaterThan(1.5)
	})

	it("reads a solid comic backwards in passes of a window turned around, not once per page", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)

		await readBack(readers, SHAPE)

		// Each pass ends at the page asked and brings the ones before it, which it decodes on its way anyway: five to eleven
		// 2 to 5 MiB pages a pass, as forward. A forward window from each page asked would be one pass per page.
		expect(model.cost.passes).toBeLessThan(PAGES / 4)
		expect(model.cost.downloads).toBe(0)
		expect(model.cost.fetched / LINEAR).toBeLessThan(5)
	})

	it("reads a long solid comic of scanned pages backwards in about its size again", async () => {
		const long = shapeOf(Array.from({ length: 200 }, (_, i) => 300 * KiB + ((i * 7919) % 101) * 2 * KiB))
		const model = modelReader("solidRar", long)
		const { readers } = readersOver(model)

		await readBack(readers, long)

		// A pass every 64 pages once the window has grown, each ending at its asked page: under three times the archive,
		// where a forward window from each page asked would decode it about a hundred times.
		expect(model.cost.passes).toBeLessThanOrEqual(6)
		expect(model.cost.fetched / long.linear).toBeLessThan(3)
	})

	it("reads big pages on a phone's budget in about twice the passes of a desktop's", async () => {
		const desktop = modelReader("solidRar")
		const phone = modelReader("solidRar")

		await readThrough(readersOver(desktop).readers, SHAPE)
		await readThrough(readersOver(phone, vi.fn(), BUDGET / 2).readers, SHAPE, BUDGET / 2)

		// The window is bound by bytes, never by its count, for 2 to 5 MiB pages: half the budget, about twice the passes.
		expect(phone.cost.passes / desktop.cost.passes).toBeGreaterThan(1.5)
		expect(phone.cost.passes / desktop.cost.passes).toBeLessThan(2.6)
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

	it("budgets the passes of two readers running at once together: the later one's window is cut to the room left", async () => {
		const one = modelReader("solidRar")
		const two = modelReader("solidRar")
		const holds: (() => void)[] = []
		let inFlight = 0
		let most = 0

		for (const model of [one, two]) {
			const pass = model.reader.readEntries.getMockImplementation()

			model.reader.readEntries.mockImplementation(async params => {
				// What the pass brings besides the asked entry (the first of a forward window).
				const brought = params.entries.slice(1).reduce((sum, entry) => sum + size(entry.index), 0)

				inFlight += brought
				most = Math.max(most, inFlight)
				await new Promise<void>(resolve => {
					holds.push(resolve)
				})

				try {
					return await (pass?.(params) ?? Promise.resolve(EMPTY_PASS))
				} finally {
					inFlight -= brought
				}
			})
		}

		const readers = createArchiveReaders({
			open: request => Promise.resolve({ reader: request.archive === ARCHIVE ? one.asReader : two.asReader, release: vi.fn() }),
			aheadBudget: () => BUDGET
		})
		const OTHER = { uuid: "b0000000-0000-0000-0000-000000000000", size: 1n } as unknown as AnyFile

		readers.register("r", ARCHIVE, false, undefined)
		readers.register("s", OTHER, false, undefined)

		const reads = [readPage(readers, 0, undefined, "r"), readPage(readers, 0, undefined, "s")]

		await vi.waitFor(() => {
			expect(holds).toHaveLength(2)
		})
		expect(most).toBeLessThanOrEqual(BUDGET)
		expect(two.reader.readEntries.mock.calls[0]?.[0].entries.length ?? 0).toBeLessThan(
			one.reader.readEntries.mock.calls[0]?.[0].entries.length ?? 0
		)

		for (const release of holds) {
			release()
		}

		await Promise.all(reads)
		expect(readers.heldBytes("r") + readers.heldBytes("s")).toBeLessThanOrEqual(BUDGET)
	})

	it("saves an entry being read from that read, not a second decode beside it", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)
		const reading = readPage(readers, 0)
		const chunks: Uint8Array[] = []
		const writer = new WritableStream<Uint8Array>({
			write: chunk => {
				chunks.push(chunk)
			}
		})
		const saved = await readers.download("r", idOf(0), writer, 0, () => undefined, {})

		expect((await reading).length).toBe(size(0))
		expect(Number(saved.bytesWritten)).toBe(size(0))
		expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(size(0))
		expect(model.cost.passes).toBe(1)
		expect(model.reader.downloadEntry).not.toHaveBeenCalled()
	})

	it("makes a solid read wait for a solid save running, then read its block once", async () => {
		const model = modelReader("solidRar")
		const hold = Promise.withResolvers<undefined>()
		let saving = 0
		let overlapped = false

		model.reader.downloadEntry.mockImplementationOnce(async params => {
			saving += 1
			await hold.promise
			await fill(params.writer, size(params.entry.index))
			saving -= 1

			return DONE
		})
		model.reader.readEntries.mockImplementation(() => {
			overlapped ||= saving > 0

			return Promise.resolve(EMPTY_PASS)
		})

		const { readers } = readersOver(model)
		const save = readers.download("r", idOf(2), new WritableStream(), size(0) + size(1), () => undefined, {})

		await vi.waitFor(() => {
			expect(saving).toBe(1)
		})

		const read = readPage(readers, 3).catch(() => undefined)

		await Promise.resolve()
		hold.resolve(undefined)
		await save
		await read
		expect(overlapped).toBe(false)
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

	it("frees an opening that resolves after a close which freed the one before it", async () => {
		const stale = modelReader("solidRar")
		const late = modelReader("solidRar")
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
		// The abandoned opening lands first and is kept; the close frees it.
		openings[0]?.resolve({ reader: stale.asReader, release: releases[0] ?? vi.fn() })
		await vi.waitFor(() => {
			expect(readers.format("r")).toBeDefined()
		})
		readers.close("r")
		expect(releases[0]).toHaveBeenCalledTimes(1)

		// The other lands after the close: nobody holds it, and it is closed and freed at once.
		openings[1]?.resolve({ reader: late.asReader, release: releases[1] ?? vi.fn() })
		await expect(second).rejects.toMatchObject({ name: "Cancelled" })
		await vi.waitFor(() => {
			expect(releases[1]).toHaveBeenCalledTimes(1)
		})
		expect(late.reader.close).toHaveBeenCalledTimes(1)
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

// 100 pages of 1 KiB in one solid block.
function shortPages() {
	return solidListing(shapeOf(Array.from({ length: 100 }, () => KiB)))
}

describe("archive readers: nested archives", () => {
	it("opens an inner archive through its parent, names its entries by its own id, and closes it with the parent", async () => {
		const outer = modelReader("solidRar")
		const inner = modelReader("solidRar")
		const innerReader = { ...inner.reader, archiveId: "inner-id" } as unknown as ReaderLike
		const nestedOpens: { entry: ArchiveEntryId; password: string | undefined }[] = []
		const readers = createArchiveReaders({
			open: () => Promise.resolve({ reader: outer.asReader, release: vi.fn() }),
			openNested: ({ entry, password }) => {
				nestedOpens.push({ entry, password })

				return Promise.resolve({ reader: innerReader, release: vi.fn() })
			},
			aheadBudget: () => BUDGET
		})
		const signal = new AbortController().signal

		readers.register("outer", ARCHIVE, false, undefined)
		expect(readers.registerNested("inner", "outer", idOf(7), "pw")).toBe(true)
		expect(readers.anon("inner")).toBe(false)
		await readers.readRange("inner", idOf(2), 0, 10, signal)

		expect(nestedOpens).toEqual([{ entry: idOf(7), password: "pw" }])
		expect(inner.reader.readEntryRange).toHaveBeenCalledWith(expect.objectContaining({ entry: { archive: "inner-id", index: 2 } }))

		readers.close("outer")
		expect(readers.has("inner")).toBe(false)
		expect(inner.reader.close).toHaveBeenCalledTimes(1)
		expect(readers.registerNested("again", "outer", idOf(7), undefined)).toBe(false)
		await expect(Promise.resolve().then(() => readers.readRange("again", idOf(2), 0, 10, signal))).rejects.toMatchObject({
			name: "Cancelled"
		})
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

	it("turned back, takes the files before the entry and throws away only what lies before and between them", () => {
		const store = storeOf([
			{ path: "z", index: 0, size: 10, access: solid(0, 200) },
			{ path: "a", index: 1, size: 10, access: solid(0, 100) },
			{ path: "b", index: 2, size: 10, access: solid(10, 100) },
			// 5 bytes of a left-out entry before it.
			{ path: "c", index: 4, size: 10, access: solid(25, 100) }
		])

		expect(entryReadPlan(store, 3, true, BUDGET, READ_AHEAD_MIN_ENTRIES, "back")).toEqual({
			maxSolidSkip: 25,
			window: [
				{ index: 1, size: 10 },
				{ index: 2, size: 10 },
				{ index: 4, size: 10 }
			],
			windowSkip: 5
		})
		// Within the budget: the files nearest the entry.
		expect(entryReadPlan(store, 3, true, 10, READ_AHEAD_MIN_ENTRIES, "back").window.map(item => item.index)).toEqual([2, 4])
		// What the pass fetches ends with the entry, as its own read's does.
		expect(entryCost(store, 3, entryReadPlan(store, 3, true, BUDGET, READ_AHEAD_MIN_ENTRIES, "back"))?.estimatedBytes).toBe(35)
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
		expect(plan.window.length).toBeLessThanOrEqual(READ_AHEAD_MIN_ENTRIES + 1)
		expect(entryReadPlan(shortPages(), 0, true, BUDGET, READ_AHEAD_MAX_ENTRIES).window).toHaveLength(READ_AHEAD_MAX_ENTRIES + 1)
		expect(entryReadPlan(shortPages(), 0, true, 4 * KiB, READ_AHEAD_MAX_ENTRIES).window).toHaveLength(5)
	})

	it("grows the window with the pages turned, from 16 to 64", () => {
		expect(readAheadEntries(0)).toBe(READ_AHEAD_MIN_ENTRIES)
		expect(readAheadEntries(8)).toBe(32)
		expect(readAheadEntries(1000)).toBe(READ_AHEAD_MAX_ENTRIES)
	})
})
