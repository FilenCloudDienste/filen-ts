import { describe, expect, it, vi } from "vitest"
import type { AnyFile, ListUpdate, UuidStr } from "@filen/sdk-rs"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import type { EntryReaderEvents } from "@/workers/originSource"
import { packEntries, storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { acquireArchiveHandle, archiveHandleRefusal } = await import("@/features/archive/lib/archiveHandle")
const { runPreviewDisposers } = await import("@/lib/workers/previewDisposers")
const { createEntryStore } = await import("@/features/archive/lib/entryStore")

type Deps = NonNullable<Parameters<typeof acquireArchiveHandle>[2]>

const DIRECT = { type: "direct", packedBytes: 10n } as const

interface ListCall {
	jobId: string
	params: ListJobParams
	emit: (event: ListJobEvent) => void
	resolve: (report: ListReportDTO) => void
}

function fileOrigin(uuid: string = TEST_ARCHIVE): ByteOrigin {
	return { kind: "file", file: { uuid: uuid as UuidStr } as unknown as AnyFile }
}

// A drive file's archive, opened.
function opened(origin: ByteOrigin, deps: Deps) {
	const result = acquireArchiveHandle(origin, undefined, deps)

	if (result.type !== "opened") {
		throw new Error("a drive file's archive was refused")
	}

	return result.handle
}

function report(extra: Partial<ListReportDTO> = {}): ListReportDTO {
	return {
		format: { type: "zip" },
		password: "notNeeded",
		entries: [],
		omittedEntries: 0n,
		undeliveredEntries: 0n,
		totals: { entries: 2n, dirs: 0n, files: 2n, bytes: 10n, skipped: 0n, bytesSkipped: 0n },
		unaccountedBytes: 0n,
		duplicates: undefined,
		error: undefined,
		...extra
	}
}

function waitingUpdate(phase: ListUpdate["phase"]): ListJobEvent {
	return {
		type: "update",
		update: {
			phase,
			runState: "running",
			bytesRead: 0n,
			archiveBytes: 100n,
			entries: 0n,
			undeliveredEntries: 0n,
			bytesPerSecond: undefined,
			etaMs: undefined,
			activeTimeMs: 0n
		}
	}
}

function harness() {
	const lists: ListCall[] = []
	const readers = new Map<string, { index: number; skip: number; events: EntryReaderEvents }>()
	let ids = 0
	const deps: Deps = {
		listArchive: vi.fn(
			(jobId: string, params: ListJobParams, _password: string | undefined, onEvent: (event: ListJobEvent) => void) => {
				return new Promise<ListReportDTO>(resolve => {
					lists.push({ jobId, params, emit: onEvent, resolve })
				})
			}
		),
		cancelJob: vi.fn<(jobId: string) => void>(),
		releaseJob: vi.fn<(jobId: string) => void>(),
		openEntryReader: vi.fn(
			(
				readerId: string,
				_archive: AnyFile,
				_password: string | undefined,
				skips: ReadonlyMap<number, number>,
				events: EntryReaderEvents
			) => {
				const [entry] = skips

				readers.set(readerId, { index: entry?.[0] ?? -1, skip: entry?.[1] ?? -1, events })
			}
		),
		releaseEntryReader: vi.fn((readerId: string) => {
			readers.delete(readerId)
		}),
		newId: () => {
			ids += 1

			return `id-${String(ids)}`
		}
	}

	function list(i: number): ListCall {
		const found = lists[i]

		if (found === undefined) {
			throw new Error(`no listing call ${String(i)}`)
		}

		return found
	}

	return { deps, list, readers }
}

describe("acquireArchiveHandle", () => {
	it("lists every entry into the caller's batches and settles to the summary, releasing its job", async () => {
		const { deps, list } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = createEntryStore()
		const waiting: boolean[] = []
		const listed = handle.list(
			batch => {
				store.append(batch)
			},
			{
				signal: new AbortController().signal,
				onWaiting: next => {
					waiting.push(next)
				}
			}
		)

		expect(list(0).params).toMatchObject({ deliverEntries: true, keepReportEntries: false, skipMacMetadata: true })
		list(0).emit(waitingUpdate("waitingForWorker"))
		list(0).emit(waitingUpdate("reading"))

		for (const batch of packEntries(["preview.jpg", "Index/Document.iwa"])) {
			list(0).emit({ type: "entries", batch })
		}

		list(0).resolve(report())

		await expect(listed).resolves.toMatchObject({ format: { type: "zip" }, totals: { files: 2 } })
		expect(store.entryCount).toBe(2)
		expect(waiting).toEqual([true, false])
		expect(deps.releaseJob).toHaveBeenCalledWith(list(0).jobId)
		handle.release()
	})

	it("rejects with the listing's error, and cancels its job on abort", async () => {
		const { deps, list } = harness()
		const handle = opened(fileOrigin(), deps)
		const abort = new AbortController()
		const listed = handle.list(() => undefined, { signal: abort.signal })

		abort.abort()
		expect(deps.cancelJob).toHaveBeenCalledWith(list(0).jobId)
		list(0).resolve(report({ error: { species: "sdk", kind: "Cancelled", label: "", message: "" } }))

		await expect(listed).rejects.toMatchObject({ dto: { kind: "Cancelled" } })
		expect(deps.releaseJob).toHaveBeenCalledWith(list(0).jobId)
		handle.release()
	})

	it("finds an entry by its exact path, else by its path up to ASCII case, and never a directory", () => {
		const { deps } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([
			{ path: "QuickLook/", access: DIRECT },
			{ path: "QuickLook/preview.pdf", access: DIRECT },
			{ path: "QuickLook/Preview.pdf", access: DIRECT },
			{ path: "PREVIEW.JPG", access: DIRECT },
			{ path: "Data/", access: DIRECT }
		])

		expect(handle.findByPath(store, "QuickLook/Preview.pdf")).toBe(2)
		expect(handle.findByPath(store, "quicklook/PREVIEW.pdf")).toBe(1)
		expect(handle.findByPath(store, "preview.jpg")).toBe(3)
		expect(handle.findByPath(store, "Data")).toBeNull()
		expect(handle.findByPath(store, "Missing/preview.jpg")).toBeNull()
		handle.release()
	})

	// Directories match as names do: exact, then up to ASCII case only.
	it("finds a directory spelled the same up to ASCII case, and no further", () => {
		const { deps } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([
			{ path: "Über/", access: DIRECT },
			{ path: "Über/Preview.pdf", access: DIRECT },
			{ path: "Data/Sub/", access: DIRECT },
			{ path: "Data/Sub/preview.jpg", access: DIRECT }
		])

		expect(handle.findByPath(store, "Über/Preview.pdf")).toBe(1)
		expect(handle.findByPath(store, "DATA/sub/preview.jpg")).toBe(3)
		// Ü and ü differ beyond ASCII; the rest of "ÜBER" differs only in ASCII case.
		expect(handle.findByPath(store, "über/Preview.pdf")).toBeNull()
		expect(handle.findByPath(store, "ÜBER/Preview.pdf")).toBe(1)
		handle.release()
	})

	it("leases an entry's whole-read origin through its own entry reader, released with the lease", async () => {
		const { deps, readers } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([{ path: "preview.jpg", index: 7, size: 2048, access: DIRECT }])
		const lease = await handle.origin(store, 0)

		expect(lease.origin).toMatchObject({
			kind: "entry",
			entry: { archive: TEST_ARCHIVE, index: 7 },
			size: 2048,
			access: "whole",
			anon: false,
			cacheKey: `${TEST_ARCHIVE}#7`
		})
		expect(readers.size).toBe(1)
		expect([...readers.values()][0]).toMatchObject({ index: 7, skip: 0 })

		lease.release()
		lease.release()
		expect(readers.size).toBe(0)
		expect(deps.releaseEntryReader).toHaveBeenCalledTimes(1)
		handle.release()
	})

	it("shares one archive per file and keeps it open while a lease holds it", async () => {
		const { deps } = harness()
		const first = opened(fileOrigin(), deps)
		const second = opened(fileOrigin(), deps)
		const other = opened(fileOrigin("other-0000-0000-0000-000000000000"), deps)
		const store = storeOf([{ path: "preview.jpg", access: DIRECT }])

		expect(second.id).toBe(first.id)
		expect(other.id).not.toBe(first.id)

		const lease = await first.origin(store, 0)

		first.release()
		second.release()
		// The lease still holds the archive: a new handle joins it.
		const third = opened(fileOrigin(), deps)

		expect(third.id).toBe(first.id)
		lease.release()
		third.release()
		other.release()

		// The last reference closed it: the next acquire opens it afresh.
		const fresh = opened(fileOrigin(), deps)

		expect(fresh.id).not.toBe(first.id)
		fresh.release()
	})

	it("closes every archive and lease at sign-out, and refuses a lease afterwards", async () => {
		const { deps, readers } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([{ path: "preview.jpg", access: DIRECT }])

		await handle.origin(store, 0)
		expect(readers.size).toBe(1)

		runPreviewDisposers()

		expect(readers.size).toBe(0)
		await expect(handle.origin(store, 0)).rejects.toThrow("closed")
		// A new acquire opens the archive afresh.
		const reopened = opened(fileOrigin(), deps)

		expect(reopened.id).not.toBe(handle.id)
		handle.release()
		reopened.release()
	})

	it("refuses every origin but a drive file before the SDK has archive readers, without throwing", () => {
		const { deps } = harness()
		const others: ByteOrigin[] = [
			{ kind: "linkedFile", file: { uuid: TEST_ARCHIVE } as unknown as AnyFile },
			{
				kind: "entry",
				reader: "r",
				entry: { archive: TEST_ARCHIVE, index: 0 },
				size: 1,
				access: "whole",
				anon: false,
				cacheKey: "k"
			},
			{ kind: "bytes", blob: new Blob(), cacheKey: "b" }
		]

		for (const origin of others) {
			expect(acquireArchiveHandle(origin, undefined, deps)).toEqual({ type: "refused", reason: "needsArchiveReader" })
			expect(archiveHandleRefusal(origin)).toBe("needsArchiveReader")
		}
	})
})
