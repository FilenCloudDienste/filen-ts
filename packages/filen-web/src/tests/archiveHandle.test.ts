import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, ListUpdate, UuidStr } from "@filen/sdk-rs"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import type { ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import type { EntryReaderEvents } from "@/workers/originSource"
import type { EntryReadPlan } from "@/lib/sdk/archiveListing"
import type { ArchiveReaderPageDeps } from "@/features/archive/lib/archiveReaders"
import { packEntries, storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { acquireArchiveHandle, archiveHandleRefusal, openArchiveHandle } = await import("@/features/archive/lib/archiveHandle")
const { acquireArchiveReader, fileTarget, nestedTarget } = await import("@/features/archive/lib/archiveReaders")
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
			activeTimeMs: 0n,
			reading: undefined
		}
	}
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

// Every test starts with no reader open.
afterEach(() => {
	runPreviewDisposers()
})

let ids = 0

function harness() {
	const lists: ListCall[] = []
	const leases = new Map<string, { readerId: string; plan: EntryReadPlan; events: EntryReaderEvents }>()
	const opened = new Map<string, { anon: boolean; password: string | undefined }>()
	const lingers: (() => void)[] = []
	// What the worker says a released reader holds read ahead.
	const held = { bytes: 0 }
	const newId = (): string => {
		ids += 1

		return `id-${String(ids)}`
	}
	const pageDeps: ArchiveReaderPageDeps = {
		open: vi.fn((id: string, _file: AnyFile, anon: boolean, password: string | undefined) => {
			opened.set(id, { anon, password })
		}),
		openNested: vi.fn((id: string, _parentId: string, _entry: unknown, password: string | undefined) => {
			opened.set(id, { anon: false, password })
		}),
		close: vi.fn((id: string) => {
			opened.delete(id)
		}),
		newId,
		heldBytes: () => Promise.resolve(held.bytes),
		linger: close => {
			lingers.push(close)

			return () => {
				lingers.splice(lingers.indexOf(close), 1)
			}
		}
	}
	const deps: Deps = {
		acquireReader: (target, password) => acquireArchiveReader(target, password, pageDeps),
		listArchive: vi.fn((_readerId: string, jobId: string, params: ListJobParams, onEvent: (event: ListJobEvent) => void) => {
			return new Promise<ListReportDTO>(resolve => {
				lists.push({ jobId, params, emit: onEvent, resolve })
			})
		}),
		cancelJob: vi.fn<(jobId: string) => void>(),
		releaseJob: vi.fn<(jobId: string) => void>(),
		leaseEntry: vi.fn((leaseId: string, readerId: string, plan: EntryReadPlan, events: EntryReaderEvents) => {
			leases.set(leaseId, { readerId, plan, events })
		}),
		releaseLease: vi.fn((leaseId: string) => {
			leases.delete(leaseId)
		}),
		newId
	}

	function list(i: number): ListCall {
		const found = lists[i]

		if (found === undefined) {
			throw new Error(`no listing call ${String(i)}`)
		}

		return found
	}

	// The lingering readers close now, once the held-bytes answers that decide to linger came.
	async function lapse(): Promise<void> {
		await settle()

		for (const close of lingers.splice(0)) {
			close()
		}
	}

	return { deps, pageDeps, list, leases, opened, lapse, held }
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

		expect(list(0).params).toEqual({ deliverEntries: true, keepReportEntries: false })
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

	it("ignores a listing's batch that arrives after its report", async () => {
		const { deps, list } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = createEntryStore()
		const listed = handle.list(
			batch => {
				store.append(batch)
			},
			{ signal: new AbortController().signal }
		)
		const [batch] = packEntries(["preview.jpg"])

		if (batch === undefined) {
			throw new Error("no batch")
		}

		list(0).emit({ type: "entries", batch })
		list(0).resolve(report())
		await listed

		// The callback's own port keeps no order with the result's: the batch comes in again, last.
		list(0).emit({ type: "entries", batch })

		expect(store.entryCount).toBe(1)
		handle.release()
	})

	it("ignores an entry lease's events that arrive after its release", async () => {
		const { deps, leases } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([{ path: "preview.jpg", index: 7, size: 2048, access: DIRECT }])
		const phases: string[] = []
		const verified = vi.fn()
		const failed = vi.fn()
		const lease = await handle.origin(store, 0, {
			phase: phase => {
				phases.push(phase)
			},
			verified,
			failed
		})
		const [held] = [...leases.values()]

		if (held === undefined) {
			throw new Error("no lease")
		}

		held.events.phase("reading")
		lease.release()
		held.events.phase("waitingForWorker")
		held.events.verified()
		held.events.failed({ species: "sdk", kind: "Cancelled", label: "", message: "" })

		expect(phases).toEqual(["reading"])
		expect(verified).not.toHaveBeenCalled()
		expect(failed).not.toHaveBeenCalled()
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

	it("leases an entry's whole-read origin on the archive's reader, planned from its listing, released with the lease", async () => {
		const { deps, leases } = harness()
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
		expect(leases.size).toBe(1)
		expect([...leases.values()][0]).toMatchObject({
			readerId: handle.id,
			plan: { maxSolidSkip: 0, window: [{ index: 7, size: 2048 }] }
		})

		lease.release()
		lease.release()
		expect(leases.size).toBe(0)
		expect(deps.releaseLease).toHaveBeenCalledTimes(1)
		handle.release()
	})

	// An iWork document in an archive's entry: listed through a reader nested in the archive's, its entries named under
	// the nested archive's own uuid, so the preview cache never takes them for the outer archive's.
	it("opens an archive held in another's entry through a nested reader, naming its entries by the nested uuid", async () => {
		const { deps, pageDeps } = harness()
		const parent = fileTarget({ uuid: TEST_ARCHIVE } as unknown as AnyFile, true)
		const nested = nestedTarget(parent, "outer-pw", 4)

		if (nested === null) {
			throw new Error("two deep is never too deep")
		}

		const handle = openArchiveHandle({ file: parent.file, uuid: `${TEST_ARCHIVE}/4`, anon: true, nested }, undefined, deps)
		const store = storeOf([{ path: "preview.jpg", index: 2, size: 64, access: DIRECT }])
		const lease = await handle.origin(store, 0)

		expect(pageDeps.openNested).toHaveBeenCalledWith(handle.id, expect.any(String), { archive: TEST_ARCHIVE, index: 4 }, undefined)
		expect(pageDeps.open).toHaveBeenCalledWith(expect.any(String), parent.file, true, "outer-pw")
		expect(lease.origin).toMatchObject({
			entry: { archive: `${TEST_ARCHIVE}/4`, index: 2 },
			anon: true,
			cacheKey: `${TEST_ARCHIVE}/4#2`
		})

		lease.release()
		handle.release()
	})

	it("shares one reader per file, client and password, kept while a lease holds it and a little after", async () => {
		const { deps, pageDeps, opened: open, lapse } = harness()
		const first = opened(fileOrigin(), deps)
		const second = opened(fileOrigin(), deps)
		const other = opened(fileOrigin("other-0000-0000-0000-000000000000"), deps)
		const locked = acquireArchiveHandle(fileOrigin(), "pw", deps)
		const linked = acquireArchiveHandle({ kind: "linkedFile", file: { uuid: TEST_ARCHIVE } as unknown as AnyFile }, undefined, deps)
		const store = storeOf([{ path: "preview.jpg", access: DIRECT }])

		expect(second.id).toBe(first.id)
		expect(other.id).not.toBe(first.id)
		expect(locked.type === "opened" && locked.handle.id).not.toBe(first.id)
		expect(linked.type === "opened" && linked.handle.id).not.toBe(first.id)
		expect(open.get(first.id)).toEqual({ anon: false, password: undefined })
		expect(linked.type === "opened" && open.get(linked.handle.id)).toEqual({ anon: true, password: undefined })

		const lease = await first.origin(store, 0)

		first.release()
		second.release()
		await lapse()
		// The lease still holds the reader: a new handle joins it.
		const third = opened(fileOrigin(), deps)

		expect(third.id).toBe(first.id)
		lease.release()
		third.release()
		// Released, it lingers: an acquire meanwhile joins it.
		const again = opened(fileOrigin(), deps)

		expect(again.id).toBe(first.id)
		again.release()
		await lapse()
		expect(pageDeps.close).toHaveBeenCalledWith(first.id)

		// The last reference lapsed: the next acquire opens it afresh.
		const fresh = opened(fileOrigin(), deps)

		expect(fresh.id).not.toBe(first.id)
		fresh.release()
		other.release()
		if (locked.type === "opened") locked.handle.release()
		if (linked.type === "opened") linked.handle.release()
		await lapse()
	})

	it("closes a reader nobody holds at once when it holds more than 4 MiB read ahead", async () => {
		const { deps, pageDeps, held } = harness()
		const handle = opened(fileOrigin(), deps)

		held.bytes = 5 * 1024 * 1024
		handle.release()
		await settle()

		expect(pageDeps.close).toHaveBeenCalledWith(handle.id)
	})

	it("closes every reader at sign-out, and refuses a lease afterwards", async () => {
		const { deps, opened: open } = harness()
		const handle = opened(fileOrigin(), deps)
		const store = storeOf([{ path: "preview.jpg", access: DIRECT }])

		await handle.origin(store, 0)
		expect(open.size).toBe(1)

		runPreviewDisposers()

		expect(open.size).toBe(0)
		await expect(handle.origin(store, 0)).rejects.toThrow("closed")
		// A new acquire opens the archive afresh.
		const reopened = opened(fileOrigin(), deps)

		expect(reopened.id).not.toBe(handle.id)
		handle.release()
		reopened.release()
		runPreviewDisposers()
	})

	it("refuses an archive inside another, or bytes the page holds, without throwing", () => {
		const { deps } = harness()
		const others: ByteOrigin[] = [
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
