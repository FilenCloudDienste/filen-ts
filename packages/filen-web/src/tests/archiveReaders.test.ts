import { describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveEntryId, ArchiveFormat, EntryByteAccess, EntryDownloadReport, EntryAccess } from "@filen/sdk-rs"
import { createArchiveReaders, type ReaderLike, type ReaderOpenRequest } from "@/workers/archiveReaders"
import { entryReadPlan } from "@/features/archive/lib/entryAccess.logic"
import { READ_AHEAD_MAX_BYTES, READ_AHEAD_MAX_ENTRIES } from "@/lib/sdk/archiveListing"
import { storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

// The worker's archive readers against a model of the SDK's: what each call fetches of the archive, so a run of entries
// read one after another (a comic's pages) can be measured against reading each one on its own, as the page did
// before it had readers.

const KiB = 1024
const MiB = 1024 * KiB
const PAGES = 50
// Each page decodes to UNPACKED bytes from PACKED bytes of the archive.
const UNPACKED = 600 * KiB
const PACKED = 400 * KiB
// The SDK's checkpoint spacing in a gzip stream's output.
const CHECKPOINT = 4 * MiB

const ARCHIVE = { uuid: TEST_ARCHIVE, size: BigInt(PAGES * PACKED) } as unknown as AnyFile

function idOf(index: number): ArchiveEntryId {
	return { archive: TEST_ARCHIVE, index }
}

// A listing of PAGES pages in one solid block, as the SDK lists a solid .cbr's members and a .tar.gz's.
function solidListing() {
	return storeOf(
		Array.from({ length: PAGES }, (_, i) => ({
			path: `page-${String(i + 1).padStart(3, "0")}.jpg`,
			index: i,
			size: UNPACKED,
			access: {
				type: "solidBlock",
				skippedBytes: BigInt(i * UNPACKED),
				estimatedPackedBytes: BigInt((i + 1) * PACKED),
				blockPackedBytes: BigInt(PAGES * PACKED)
			} satisfies EntryAccess
		}))
	)
}

async function fill(writer: WritableStream<Uint8Array>, size: number): Promise<void> {
	const w = writer.getWriter()

	await w.write(new Uint8Array(size))
	await w.close()
}

const DONE: EntryDownloadReport = { bytesWritten: 0n, bytesRead: 0n, checked: true, error: undefined }

// The SDK's reader as far as cost goes. A solid RAR (`sequential`): every pass and every download decodes the block from
// its start. A gzip tar (`seekable`): one decoder over the tar's stream goes on from where it stopped, else from the
// last checkpoint at or before the read.
function modelReader(kind: "solidRar" | "gzipTar") {
	const cost = { fetched: 0, passes: 0, downloads: 0, ranges: 0, skips: [] as number[] }
	let cursor = 0
	let decodedTo = 0
	const format: ArchiveFormat = kind === "solidRar" ? { type: "rar", version: "rar50Plus" } : { type: "tar", codec: "gzip" }
	// Packed bytes the decoder takes for `unpacked` bytes of output.
	const packed = (unpacked: number): number => (unpacked * PACKED) / UNPACKED

	const reader = {
		format,
		entryByteAccess: (): Promise<EntryByteAccess> =>
			Promise.resolve(
				kind === "solidRar" ? { type: "sequential", size: BigInt(UNPACKED) } : { type: "seekable", size: BigInt(UNPACKED) }
			),
		downloadEntry: async (params: { entry: ArchiveEntryId; writer: WritableStream<Uint8Array> }): Promise<EntryDownloadReport> => {
			cost.downloads += 1
			cost.fetched += (params.entry.index + 1) * PACKED
			await fill(params.writer, UNPACKED)

			return DONE
		},
		readEntries: async (params: {
			entries: ArchiveEntryId[]
			writerFor: (entry: ArchiveEntryId, size: bigint | undefined) => WritableStream<Uint8Array> | undefined
			maxSolidSkip: bigint | number | null
		}) => {
			const indexes = params.entries.map(entry => entry.index).sort((a, b) => a - b)
			const first = indexes[0] ?? 0
			const last = indexes.at(-1) ?? 0

			cost.passes += 1
			cost.skips.push(Number(params.maxSolidSkip))
			// What the pass throws away: everything the block stores before its first entry.
			expect(first * UNPACKED).toBeLessThanOrEqual(Number(params.maxSolidSkip))
			cost.fetched += (last + 1) * PACKED

			for (const index of indexes) {
				const writer = params.writerFor(idOf(index), BigInt(UNPACKED))

				if (writer !== undefined) {
					await fill(writer, UNPACKED)
				}
			}

			return { entries: BigInt(indexes.length), bytesWritten: 0n, bytesRead: 0n, checked: true, error: undefined }
		},
		readEntryRange: async (params: {
			entry: ArchiveEntryId
			start: bigint | number
			end: bigint | number
			writer: WritableStream<Uint8Array>
		}) => {
			const from = params.entry.index * UNPACKED + Number(params.start)
			const to = params.entry.index * UNPACKED + Number(params.end)
			// On from the cursor, else from the checkpoint before the read (laid as the output passed it).
			const start =
				from >= cursor
					? cursor
					: Math.min(Math.floor(from / CHECKPOINT) * CHECKPOINT, Math.floor(decodedTo / CHECKPOINT) * CHECKPOINT)

			cost.ranges += 1
			cost.fetched += packed(to - start)
			cursor = to
			decodedTo = Math.max(decodedTo, to)
			await fill(params.writer, to - from)
		},
		list: vi.fn(),
		close: vi.fn(),
		free: vi.fn()
	}

	return { reader: reader as unknown as ReaderLike, cost }
}

function readersOver(model: ReturnType<typeof modelReader>) {
	const opens: ReaderOpenRequest[] = []
	const readers = createArchiveReaders({
		open: request => {
			opens.push(request)

			return Promise.resolve({ reader: model.reader, release: vi.fn() })
		}
	})

	readers.register("r", ARCHIVE, false, undefined)

	return { readers, opens }
}

const EVENTS = { phase: () => undefined, verified: () => undefined, failed: () => undefined }

// The pages read in turn, each once its predecessor arrived, as a reader turning them does.
async function readInTurn(model: ReturnType<typeof modelReader>): Promise<void> {
	const { readers } = readersOver(model)
	const store = solidListing()

	for (let slot = 0; slot < PAGES; slot++) {
		const bytes = await readers.readWhole(
			"r",
			idOf(store.index(slot)),
			UNPACKED,
			entryReadPlan(store, slot),
			EVENTS,
			new AbortController().signal
		)

		expect(bytes.length).toBe(UNPACKED)
	}
}

// Before readers: every page a one-shot download, decoding the block (or the tar's stream) from its start to the page.
async function readOneShot(model: ReturnType<typeof modelReader>): Promise<void> {
	for (let index = 0; index < PAGES; index++) {
		await model.reader.downloadEntry({ entry: idOf(index), writer: new WritableStream(), maxSolidSkip: index * UNPACKED })
	}
}

describe("archive readers: sequential entries of a solid archive", () => {
	const linear = PAGES * PACKED

	it("read a solid .cbr's 50 pages in passes of a read-ahead window, about linear instead of quadratic", async () => {
		const before = modelReader("solidRar")
		const after = modelReader("solidRar")

		await readOneShot(before)
		await readInTurn(after)

		// One-shot: page i fetches the block up to it, Σ (i + 1) pages = 1275 pages' worth.
		expect(before.cost.fetched).toBe(((PAGES * (PAGES + 1)) / 2) * PACKED)
		// Windows of the page and the 16 after it: passes ending at 17, 34 and 50 pages, 101 pages' worth.
		expect(after.cost.passes).toBe(Math.ceil(PAGES / (READ_AHEAD_MAX_ENTRIES + 1)))
		expect(after.cost.downloads).toBe(0)
		expect(after.cost.fetched).toBe((17 + 34 + 50) * PACKED)
		expect(after.cost.fetched).toBeLessThan(2.1 * linear)
		expect(before.cost.fetched / after.cost.fetched).toBeGreaterThan(12)
		// Each pass may throw away its last page's listed skip, no more.
		expect(after.cost.skips).toEqual([16 * UNPACKED, 33 * UNPACKED, 49 * UNPACKED])
	})

	it("read a .tar.gz's 50 members through range reads that decode on from the last one, exactly linear", async () => {
		const before = modelReader("gzipTar")
		const after = modelReader("gzipTar")

		await readOneShot(before)
		await readInTurn(after)

		expect(before.cost.fetched).toBe(((PAGES * (PAGES + 1)) / 2) * PACKED)
		expect(after.cost.ranges).toBe(PAGES)
		expect(after.cost.passes).toBe(0)
		expect(after.cost.fetched).toBe(linear)
	})

	it("serves a page the running pass is writing from that pass, not a second decode", async () => {
		const model = modelReader("solidRar")
		const { readers, opens } = readersOver(model)
		const store = solidListing()
		const signal = new AbortController().signal
		const [first, second] = await Promise.all([
			readers.readWhole("r", idOf(0), UNPACKED, entryReadPlan(store, 0), EVENTS, signal),
			readers.readWhole("r", idOf(1), UNPACKED, entryReadPlan(store, 1), EVENTS, signal)
		])

		expect(first.length).toBe(UNPACKED)
		expect(second.length).toBe(UNPACKED)
		expect(model.cost.passes).toBe(1)
		// One opening, shared.
		expect(opens).toHaveLength(1)
	})

	it("plans a window inside one block, within the read-ahead's bytes, and a lone entry outside a solid block", () => {
		const big = storeOf(
			Array.from({ length: 6 }, (_, i) => ({
				path: `v${String(i)}.bin`,
				index: i,
				size: 12 * MiB,
				access: {
					type: "solidBlock",
					skippedBytes: BigInt(i * 12 * MiB),
					estimatedPackedBytes: BigInt((i + 1) * 12 * MiB),
					blockPackedBytes: BigInt(72 * MiB)
				} satisfies EntryAccess
			}))
		)
		const plan = entryReadPlan(big, 1)

		// 12 MiB each: two fit the 32 MiB read-ahead after the entry.
		expect(plan.window.map(item => item.index)).toEqual([1, 2, 3])
		expect(plan.window.slice(1).reduce((sum, item) => sum + item.size, 0)).toBeLessThanOrEqual(READ_AHEAD_MAX_BYTES)
		expect(plan).toMatchObject({ maxSolidSkip: 12 * MiB, windowSkip: 36 * MiB })

		// A second block starts over: its first file's skip is below the window's.
		const blocks = storeOf([
			{
				path: "a",
				index: 0,
				size: 10,
				access: { type: "solidBlock", skippedBytes: 0n, estimatedPackedBytes: 5n, blockPackedBytes: 10n }
			},
			{
				path: "b",
				index: 1,
				size: 10,
				access: { type: "solidBlock", skippedBytes: 10n, estimatedPackedBytes: 10n, blockPackedBytes: 10n }
			},
			{
				path: "c",
				index: 2,
				size: 10,
				access: { type: "solidBlock", skippedBytes: 0n, estimatedPackedBytes: 5n, blockPackedBytes: 10n }
			}
		])

		expect(entryReadPlan(blocks, 0).window.map(item => item.index)).toEqual([0, 1])

		const direct = storeOf([{ path: "a", index: 0, size: 10, access: { type: "direct", packedBytes: 10n } }])

		expect(entryReadPlan(direct, 0)).toEqual({ maxSolidSkip: 0, window: [{ index: 0, size: 10 }], windowSkip: 0 })
	})

	it("keeps no more decoded ahead than the read-ahead allows, and nothing once closed", async () => {
		const model = modelReader("solidRar")
		const { readers } = readersOver(model)
		const store = solidListing()
		const signal = new AbortController().signal

		await readers.readWhole("r", idOf(0), UNPACKED, entryReadPlan(store, 0), EVENTS, signal)
		expect(model.cost.passes).toBe(1)

		// Page 16 came with page 0's pass.
		await readers.readWhole("r", idOf(16), UNPACKED, entryReadPlan(store, 16), EVENTS, signal)
		expect(model.cost.passes).toBe(1)

		readers.close("r")
		await expect(readers.readWhole("r", idOf(1), UNPACKED, entryReadPlan(store, 1), EVENTS, signal)).rejects.toThrow("closed")
		expect(model.reader.close).toHaveBeenCalledTimes(1)
	})
})
