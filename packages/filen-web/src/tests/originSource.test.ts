import { describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveEntryId } from "@filen/sdk-rs"
import { bytesOrigin, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import {
	ENTRY_RANGE_BUFFER_CAP,
	clearEntryReaders,
	entryReader,
	originFile,
	originSource,
	registerEntryReader,
	releaseEntryReader,
	type EntryReaderRecord,
	type FileReadClient,
	type OriginSourceDeps
} from "@/workers/originSource"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const file = mockLinkedFile({ uuid: "b0000000-0000-0000-0000-000000000000", size: 10n })
const content = Uint8Array.from({ length: 10 }, (_, i) => i)

function fakeClient() {
	const readRange = vi.fn((_file: AnyFile, start: number, end: number, _signal: AbortSignal) =>
		Promise.resolve(content.slice(start, end))
	)
	const release = vi.fn()
	const client: FileReadClient = { readRange, release }

	return { client, readRange, release }
}

function record(anon = false): EntryReaderRecord {
	return { anon, archive: file, password: undefined, maxSolidSkip: () => 0 }
}

function setUp(records: Record<string, EntryReaderRecord> = {}) {
	const session = fakeClient()
	const linked = fakeClient()
	const readEntry = vi.fn((_record: EntryReaderRecord, _entry: ArchiveEntryId, size: number) => Promise.resolve(content.slice(0, size)))
	const deps: OriginSourceDeps = {
		session: () => session.client,
		linked: () => linked.client,
		entryReader: id => records[id],
		readEntry
	}

	return { session, linked, readEntry, deps }
}

function entry(size = 10, anon = false, reader = "r"): ByteOrigin {
	return { kind: "entry", reader, entry: { archive: file.uuid, index: 1 }, size, access: "whole", anon, cacheKey: `${file.uuid}#1` }
}

describe("originSource", () => {
	it("reads a drive file through the session client and a linked file through its own, freed on release", async () => {
		const { session, linked, deps } = setUp()
		const own = originSource({ kind: "file", file }, deps)
		const anon = originSource({ kind: "linkedFile", file }, deps)
		const signal = new AbortController().signal

		expect(own.size).toBe(10)
		await expect(own.read(2, 5, signal)).resolves.toEqual(Uint8Array.of(2, 3, 4))
		await expect(anon.readWhole(10, signal)).resolves.toEqual(content)
		expect(session.readRange).toHaveBeenCalledTimes(1)
		expect(linked.readRange).toHaveBeenCalledTimes(1)

		anon.release()
		expect(linked.release).toHaveBeenCalledTimes(1)
		expect(session.release).not.toHaveBeenCalled()
	})

	it("refuses a whole read above its cap before reading", async () => {
		const { session, deps } = setUp()

		await expect(originSource({ kind: "file", file }, deps).readWhole(9, new AbortController().signal)).rejects.toThrow("above its cap")
		expect(session.readRange).not.toHaveBeenCalled()
	})

	it("serves an entry's ranges from one checked whole read, each range a copy", async () => {
		const { readEntry, deps } = setUp({ r: record() })
		const source = originSource(entry(), deps)
		const signal = new AbortController().signal
		const [a, b] = await Promise.all([source.read(0, 4, signal), source.read(6, 10, signal)])

		expect(a).toEqual(Uint8Array.of(0, 1, 2, 3))
		expect(b).toEqual(Uint8Array.of(6, 7, 8, 9))
		expect(a.buffer.byteLength).toBe(4)
		expect(readEntry).toHaveBeenCalledTimes(1)

		source.release()
		await expect(source.read(0, 1, signal)).rejects.toThrow()
	})

	it("reads an entry whole on its own, without holding it", async () => {
		const { readEntry, deps } = setUp({ r: record() })
		const source = originSource(entry(), deps)

		await expect(source.readWhole(10, new AbortController().signal)).resolves.toEqual(content)
		await expect(source.readWhole(10, new AbortController().signal)).resolves.toEqual(content)
		expect(readEntry).toHaveBeenCalledTimes(2)
	})

	it("does not buffer an entry above the largest whole-buffer preview", async () => {
		const { readEntry, deps } = setUp({ r: record() })
		const source = originSource(entry(ENTRY_RANGE_BUFFER_CAP + 1), deps)

		await expect(source.read(0, 1, new AbortController().signal)).rejects.toThrow("above its cap")
		expect(readEntry).not.toHaveBeenCalled()
	})

	it("retries an entry load that failed", async () => {
		const { readEntry, deps } = setUp({ r: record() })

		readEntry.mockRejectedValueOnce(new Error("network"))

		const source = originSource(entry(), deps)
		const signal = new AbortController().signal

		await expect(source.read(0, 1, signal)).rejects.toThrow("network")
		await expect(source.read(0, 1, signal)).resolves.toEqual(Uint8Array.of(0))
		expect(readEntry).toHaveBeenCalledTimes(2)
	})

	it("refuses an entry whose reader is closed or belongs to the other client", () => {
		const { deps } = setUp({ r: record(true) })

		expect(() => originSource(entry(10, true, "gone"), deps)).toThrow("closed")
		expect(() => originSource(entry(10, false), deps)).toThrow("other client")
		expect(() => originSource(entry(10, true), deps)).not.toThrow()
	})

	it("never reads a bytes origin in the SDK worker", () => {
		const { deps } = setUp()

		expect(() => originSource(bytesOrigin(new Blob([content]), "k"), deps)).toThrow()
	})

	it("names the file behind file origins only", () => {
		expect(originFile({ kind: "file", file })).toEqual({ anon: false, file })
		expect(originFile({ kind: "linkedFile", file })).toEqual({ anon: true, file })
		expect(originFile(entry())).toBeNull()
		expect(originFile(bytesOrigin(new Blob([]), "k"))).toBeNull()
	})

	it("registers, releases and clears entry readers", () => {
		registerEntryReader("first", record())
		registerEntryReader("second", record(true))

		expect(entryReader("first")?.anon).toBe(false)
		releaseEntryReader("first")
		expect(entryReader("first")).toBeUndefined()
		clearEntryReaders()
		expect(entryReader("second")).toBeUndefined()
	})
})
