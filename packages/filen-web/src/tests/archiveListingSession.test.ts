import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveFormat, ListUpdate, UuidStr } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import { log } from "@/lib/log"
import type { ArchiveNameInfo, ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { packEntries, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { createListingCache } = await import("@/features/archive/lib/listingCache")
const { defaultListingDeps, openListingSession } = await import("@/features/archive/lib/listingSession")

type ListingDeps = Parameters<typeof openListingSession>[1] & object

interface Call {
	id: string
	params: ListJobParams
	password: string | undefined
	emit: (event: ListJobEvent) => void
	resolve: (report: ListReportDTO) => void
	reject: (reason: unknown) => void
}

const MiB = 1024 * 1024

function source(name: string, size: number, uuid = TEST_ARCHIVE): ArchiveSource {
	return { file: { uuid } as unknown as AnyFile, uuid: uuid as UuidStr, name, size, ownParent: null }
}

function nameInfo(format: ArchiveFormat | null): ArchiveNameInfo {
	return { format, defaultName: "archive" }
}

function harness(info: ArchiveNameInfo | Promise<ArchiveNameInfo> = nameInfo({ type: "zip" })) {
	const calls: Call[] = []
	let ids = 0
	const deps: ListingDeps = {
		listArchive: vi.fn((id: string, params: ListJobParams, password: string | undefined, onEvent: (event: ListJobEvent) => void) => {
			return new Promise<ListReportDTO>((resolve, reject) => {
				calls.push({ id, params, password, emit: onEvent, resolve, reject })
			})
		}),
		cancel: vi.fn<(id: string) => void>(),
		release: vi.fn<(id: string) => void>(),
		newId: () => {
			ids += 1

			return `job-${String(ids)}`
		},
		delay: defaultListingDeps.delay,
		nameInfo: () => info
	}

	function call(i: number): Call {
		const found = calls[i]

		if (found === undefined) {
			throw new Error(`no listing call ${String(i)}`)
		}

		return found
	}

	return { calls, call, deps }
}

function update(phase: ListUpdate["phase"], extra: Partial<ListUpdate> = {}): ListJobEvent {
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
			...extra
		}
	}
}

function entriesEvent(paths: string[]): ListJobEvent {
	const [batch] = packEntries(paths)

	if (batch === undefined) {
		throw new Error("no batch")
	}

	return { type: "entries", batch }
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

function sdkError(kind: string): ErrorDTO {
	return { species: "sdk", kind, label: kind, message: kind }
}

// Lets the settle's promise chain run.
async function settled(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("openListingSession", () => {
	it("starts a zip's listing once it has been shown for 150 ms", async () => {
		const { calls, call, deps } = harness()
		const zip = source("a.zip", 5 * 1024 * MiB)
		const session = openListingSession(zip, deps)

		expect(session.getSnapshot().phase.type).toBe("starting")
		expect(session.getSnapshot().info).toEqual(nameInfo({ type: "zip" }))

		await vi.advanceTimersByTimeAsync(149)

		expect(calls).toHaveLength(0)

		await vi.advanceTimersByTimeAsync(1)

		expect(call(0).params).toEqual({ archive: zip.file, skipMacMetadata: true, keepReportEntries: false, deliverEntries: true })
		expect(call(0).password).toBeUndefined()
	})

	it("starts nothing for an archive passed by before the delay", async () => {
		const { calls, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		await vi.advanceTimersByTimeAsync(100)
		session.dispose()
		await vi.advanceTimersByTimeAsync(1000)

		expect(calls).toHaveLength(0)
	})

	it("gates a large tar until asked, and lists a small one at once", async () => {
		const big = harness(nameInfo({ type: "tar", codec: "gzip" }))
		const gated = openListingSession(source("a.tar.gz", 9 * MiB), big.deps)

		expect(gated.getSnapshot().phase).toEqual({ type: "gate", format: { type: "tar", codec: "gzip" } })

		await vi.advanceTimersByTimeAsync(5000)

		expect(big.calls).toHaveLength(0)

		gated.start()

		expect(big.calls).toHaveLength(1)
		expect(gated.getSnapshot().phase.type).toBe("starting")

		const small = harness(nameInfo({ type: "tar", codec: "gzip" }))

		openListingSession(source("b.tar.gz", 8 * MiB), small.deps)
		await vi.advanceTimersByTimeAsync(150)

		expect(small.calls).toHaveLength(1)
	})

	it("waits for the name's format when it is not known yet", async () => {
		let answer: (info: ArchiveNameInfo) => void = () => undefined
		const { deps } = harness(
			new Promise<ArchiveNameInfo>(resolve => {
				answer = resolve
			})
		)
		const session = openListingSession(source("a.bin", 10 * MiB), deps)

		expect(session.getSnapshot().phase.type).toBe("resolving")

		answer(nameInfo(null))
		await settled()

		expect(session.getSnapshot().phase).toEqual({ type: "gate", format: null })
	})

	it("moves through the phases on updates, and appends batches without telling anyone", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)
		const listener = vi.fn()

		session.subscribe(listener)
		session.start()

		const { emit, resolve } = call(0)
		const store = session.getSnapshot().store

		listener.mockClear()
		emit(update("waitingForWorker"))

		expect(session.getSnapshot().phase).toEqual({ type: "waiting" })
		expect(listener).toHaveBeenCalledTimes(1)

		emit(entriesEvent(["a", "b"]))

		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.entryCount).toBe(2)

		emit(update("reading", { bytesRead: 40n, entries: 2n, bytesPerSecond: 20n, etaMs: 3000n }))

		expect(listener).toHaveBeenCalledTimes(2)
		expect(session.getSnapshot().phase).toEqual({
			type: "reading",
			bytesRead: 40,
			archiveBytes: 100,
			entries: 2,
			bytesPerSecond: 20,
			etaMs: 3000
		})

		resolve(report({ duplicates: { names: ["x"], count: 3n } }))
		await settled()

		const phase = session.getSnapshot().phase

		expect(phase.type).toBe("done")
		expect(phase.type === "done" ? phase.summary : null).toMatchObject({
			format: { type: "zip" },
			totals: { entries: 2, files: 2, bytes: 10 },
			duplicates: { names: ["x"], count: 3 }
		})
		expect(session.getSnapshot().store).toBe(store)
		expect(listener).toHaveBeenCalledTimes(3)
	})

	it("cancels on stop, releases only once the run settled, and keeps what was read", async () => {
		const { call, deps } = harness(nameInfo({ type: "tar", codec: undefined }))
		const session = openListingSession(source("a.tar", 100 * MiB), deps)

		session.start()
		call(0).emit(entriesEvent(["a"]))
		session.stop()

		expect(deps.cancel).toHaveBeenCalledWith("job-1")
		expect(deps.release).not.toHaveBeenCalled()

		call(0).resolve(report({ error: sdkError("Cancelled") }))
		await settled()

		expect(deps.release).toHaveBeenCalledWith("job-1")
		expect(session.getSnapshot().phase.type).toBe("stopped")
		expect(session.getSnapshot().store.entryCount).toBe(1)
	})

	it("stopping before anything was read shows the gate again, which lists anew", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()
		call(0).emit(update("waitingForWorker"))
		session.stop()
		call(0).resolve(report({ format: { type: "zip" }, error: sdkError("Cancelled") }))
		await settled()

		expect(session.getSnapshot().phase).toEqual({ type: "gate", format: { type: "zip" } })

		session.start()

		expect(call(1).params.deliverEntries).toBe(true)
		expect(session.getSnapshot().phase.type).toBe("starting")
	})

	it("stopping before the delay ran out shows the gate", async () => {
		const { calls, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.stop()
		await vi.advanceTimersByTimeAsync(500)

		expect(calls).toHaveLength(0)
		expect(session.getSnapshot().phase).toEqual({ type: "gate", format: { type: "zip" } })
	})

	it("drops a previous run's events and settle", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()

		const first = call(0)

		first.reject(new Error("worker gone"))
		await settled()

		expect(session.getSnapshot().phase.type).toBe("failed")
		expect(deps.release).toHaveBeenCalledWith("job-1")

		session.retry()

		const second = call(1)
		const store = session.getSnapshot().store

		expect(second.id).toBe("job-2")

		first.emit(entriesEvent(["stale"]))
		first.emit(update("reading"))

		expect(store.entryCount).toBe(0)
		expect(session.getSnapshot().phase.type).toBe("starting")

		// Disposed: the running one's events no longer land either.
		session.dispose()
		second.emit(entriesEvent(["late"]))

		expect(store.entryCount).toBe(0)
		expect(deps.cancel).toHaveBeenCalledWith("job-2")
		expect(deps.release).toHaveBeenCalledTimes(1)

		second.resolve(report({ error: sdkError("Cancelled") }))
		await settled()

		expect(deps.release).toHaveBeenLastCalledWith("job-2")
	})

	it("maps each way a listing ends", async () => {
		const cases: { result: ListReportDTO | Error; phase: Record<string, unknown> }[] = [
			{ result: report({ error: sdkError("ArchiveCorrupt") }), phase: { type: "failed", error: sdkError("ArchiveCorrupt") } },
			{ result: report({ error: sdkError("ArchiveTooLarge") }), phase: { type: "failed", error: sdkError("ArchiveTooLarge") } },
			{ result: report({ error: sdkError("ArchivePasswordRequired") }), phase: { type: "needsPassword", wrong: false } },
			{ result: report({ error: sdkError("ArchiveWrongPassword") }), phase: { type: "needsPassword", wrong: true } },
			{ result: new Error("bad args"), phase: { type: "failed", summary: null } }
		]

		for (const { result, phase } of cases) {
			const { call, deps } = harness()
			const session = openListingSession(source("a.7z", 10), deps)

			session.start()

			if (result instanceof Error) {
				call(0).reject(result)
			} else {
				call(0).emit(entriesEvent(["partial"]))
				call(0).resolve(result)
			}

			await settled()

			expect(session.getSnapshot().phase).toMatchObject(phase)
		}
	})

	it("keeps the entries read before a failure", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()
		call(0).emit(entriesEvent(["a", "b"]))
		call(0).resolve(report({ error: sdkError("ArchiveCorrupt") }))
		await settled()

		const phase = session.getSnapshot().phase

		expect(phase.type === "failed" ? phase.summary?.totals.entries : null).toBe(2)
		expect(session.getSnapshot().store.entryCount).toBe(2)
	})

	it("lists again with the password when nothing could be listed without it", async () => {
		const { call, deps } = harness(nameInfo({ type: "sevenZ" }))
		const session = openListingSession(source("a.7z", 10), deps)

		session.start()
		call(0).resolve(report({ format: { type: "sevenZ" }, password: "required", error: sdkError("ArchivePasswordRequired") }))
		await settled()

		const before = session.getSnapshot().store

		session.submitPassword("wrong-one")

		expect(call(1).password).toBe("wrong-one")
		expect(call(1).params.deliverEntries).toBe(true)

		call(1).resolve(report({ format: { type: "sevenZ" }, password: "wrong", error: sdkError("ArchiveWrongPassword") }))
		await settled()

		expect(session.getSnapshot().phase).toEqual({ type: "needsPassword", wrong: true })
		expect(session.password()).toBeUndefined()

		session.submitPassword("right-one")
		call(2).emit(entriesEvent(["a"]))
		call(2).resolve(report({ format: { type: "sevenZ" }, password: "right" }))
		await settled()

		expect(session.getSnapshot().phase.type).toBe("done")
		expect(session.getSnapshot().store).not.toBe(before)
		expect(session.getSnapshot().store.entryCount).toBe(1)
		expect(session.password()).toBe("right-one")
	})

	it("checks a password against the entries shown without listing them again", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()
		call(0).emit(entriesEvent(["secret"]))
		call(0).resolve(report({ password: "required" }))
		await settled()

		const store = session.getSnapshot().store

		session.submitPassword("nope")

		expect(call(1).params.deliverEntries).toBe(false)
		expect(call(1).password).toBe("nope")

		const verifying = session.getSnapshot().phase

		expect(verifying.type === "done" ? verifying.summary.verifying : null).toBe(true)

		// Its updates leave what is shown alone.
		call(1).emit(update("reading"))

		expect(session.getSnapshot().phase.type).toBe("done")

		call(1).resolve(report({ password: "wrong" }))
		await settled()

		const wrong = session.getSnapshot().phase

		expect(wrong.type === "done" ? wrong.summary : null).toMatchObject({ password: "wrong", verifying: false })
		expect(session.password()).toBeUndefined()

		session.submitPassword("yes")
		call(2).resolve(report({ password: "right" }))
		await settled()

		const right = session.getSnapshot().phase

		expect(right.type === "done" ? right.summary : null).toMatchObject({ password: "right", verifying: false })
		expect(session.password()).toBe("yes")
		expect(session.getSnapshot().store).toBe(store)
		expect(deps.release).toHaveBeenCalledTimes(3)
	})

	it("takes a password an entry proved right, quieting the encrypted banner without a check", async () => {
		const { calls, call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()
		call(0).emit(entriesEvent(["secret"]))
		call(0).resolve(report({ password: "required" }))
		await settled()

		const listener = vi.fn()

		session.subscribe(listener)
		session.acceptPassword("")

		expect(session.password()).toBeUndefined()
		expect(listener).not.toHaveBeenCalled()

		session.acceptPassword("entry-pw")

		const phase = session.getSnapshot().phase

		expect(session.password()).toBe("entry-pw")
		expect(phase.type === "done" ? phase.summary.password : null).toBe("right")
		expect(calls).toHaveLength(1)

		session.dispose()
		session.acceptPassword("late")

		expect(session.password()).toBeUndefined()
	})

	it("says while a check waits for the slot, and a stop ends the check alone", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)
		const summary = () => {
			const phase = session.getSnapshot().phase

			return phase.type === "done" ? phase.summary : null
		}

		session.start()
		call(0).emit(entriesEvent(["secret"]))
		call(0).resolve(report({ password: "required" }))
		await settled()

		session.submitPassword("pw")
		call(1).emit(update("waitingForWorker"))

		expect(summary()).toMatchObject({ verifying: true, verifyWaiting: true })

		call(1).emit(update("reading"))

		expect(summary()).toMatchObject({ verifying: true, verifyWaiting: false })

		call(1).emit(update("waitingForWorker"))
		session.stop()

		expect(deps.cancel).toHaveBeenCalledWith("job-2")

		call(1).resolve(report({ error: sdkError("Cancelled") }))
		await settled()

		expect(summary()).toMatchObject({ password: "required", verifying: false, verifyWaiting: false, verifyError: null })
		expect(session.getSnapshot().store.entryCount).toBe(1)
		expect(session.password()).toBeUndefined()
	})

	it("reports a check that could not tell, keeping the password unaccepted", async () => {
		const { call, deps } = harness()
		const session = openListingSession(source("a.zip", 10), deps)

		session.start()
		call(0).emit(entriesEvent(["secret"]))
		call(0).resolve(report({ password: "required" }))
		await settled()

		session.submitPassword("pw")
		call(1).resolve(report({ password: "unchecked", error: sdkError("Reqwest") }))
		await settled()

		const phase = session.getSnapshot().phase

		expect(phase.type === "done" ? phase.summary : null).toMatchObject({ password: "required", verifyError: sdkError("Reqwest") })
		expect(session.password()).toBeUndefined()
	})

	it("reopens a completed listing from the host's cache, where it was left", async () => {
		const { call, calls, deps } = harness()
		const cache = createListingCache()
		const first = openListingSession(source("a.zip", 10), deps, cache)

		first.start()
		call(0).emit(entriesEvent(["a"]))
		call(0).resolve(report({ password: "required" }))
		await settled()
		first.submitPassword("pw")
		call(1).resolve(report({ password: "right" }))
		await settled()
		first.rememberDirPath("docs")

		const store = first.getSnapshot().store

		first.dispose()

		expect(cache.get(TEST_ARCHIVE)?.entries).toBe(1)

		const again = openListingSession(source("a.zip", 10), deps, cache)

		expect(again.getSnapshot().phase.type).toBe("done")
		expect(again.getSnapshot().store).toBe(store)
		expect(again.password()).toBe("pw")
		expect(again.restoredDirPath()).toBe("docs")

		await vi.advanceTimersByTimeAsync(1000)

		expect(calls).toHaveLength(2)
	})

	it("caches only a completed listing", async () => {
		const { call, deps } = harness(nameInfo({ type: "tar", codec: undefined }))
		const cache = createListingCache()
		const session = openListingSession(source("a.tar", 1), deps, cache)

		await vi.advanceTimersByTimeAsync(150)
		call(0).emit(entriesEvent(["a"]))
		session.dispose()

		expect(cache.get(TEST_ARCHIVE)).toBeUndefined()
	})

	it("caches nothing once its host's cache closed", async () => {
		const { call, deps } = harness()
		const cache = createListingCache()
		const session = openListingSession(source("a.zip", 10), deps, cache)

		session.start()
		call(0).emit(entriesEvent(["a"]))
		call(0).resolve(report())
		await settled()
		cache.close()
		session.dispose()

		expect(cache.get(TEST_ARCHIVE)).toBeUndefined()
	})

	it("starts a fresh listing at the root, whatever the cached one remembered", async () => {
		const { call, deps } = harness()
		const cache = createListingCache()
		const first = openListingSession(source("a.zip", 10), deps, cache)

		first.start()
		call(0).emit(entriesEvent(["docs/a"]))
		call(0).resolve(report())
		await settled()
		first.rememberDirPath("docs")
		first.dispose()

		const again = openListingSession(source("a.zip", 10), deps, cache)

		expect(again.restoredDirPath()).toBe("docs")

		again.retry()

		expect(again.restoredDirPath()).toBe("")
	})

	it("never logs the password", async () => {
		const spies = (["debug", "info", "log", "warn", "error"] as const).map(level =>
			vi.spyOn(console, level).mockImplementation(() => undefined)
		)
		const { call, deps } = harness(nameInfo({ type: "sevenZ" }))
		const session = openListingSession(source("a.7z", 10), deps)

		session.start()
		call(0).resolve(report({ error: sdkError("ArchivePasswordRequired") }))
		await settled()
		session.submitPassword("hunter2-secret")
		call(1).reject(new Error("worker gone"))
		await settled()
		session.submitPassword("hunter2-secret")
		call(2).resolve(report({ password: "right" }))
		await settled()

		const logged = JSON.stringify([...spies.flatMap(spy => spy.mock.calls), log.dump()])

		expect(logged).not.toContain("hunter2-secret")
		expect(JSON.stringify(session.getSnapshot())).not.toContain("hunter2-secret")

		session.dispose()

		expect(session.password()).toBeUndefined()

		for (const spy of spies) {
			spy.mockRestore()
		}
	})
})
