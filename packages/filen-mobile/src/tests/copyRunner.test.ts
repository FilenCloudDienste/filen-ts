// The copy runner against a spied SDK boundary (copyItems / copyItemsTo drive the callbacks the way the
// Rust side does) and the real job and transfers stores: rows, progress write rate, callback rules,
// handle disposal, the quota pre-flight, cancel/trash, retry and the logout epoch.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => {
	const disposals = { pause: 0, sdkAbort: 0, composite: 0 }

	class FakePauseSignal {
		private paused = false
		private readonly listeners = { pause: new Set<() => void>(), resume: new Set<() => void>() }

		public pause(): void {
			this.paused = true
			this.listeners.pause.forEach(listener => listener())
		}

		public resume(): void {
			this.paused = false
			this.listeners.resume.forEach(listener => listener())
		}

		public isPaused(): boolean {
			return this.paused
		}

		public getSignal(): object {
			return { pauseSignal: true }
		}

		public addEventListener(event: "pause" | "resume", callback: () => void) {
			this.listeners[event].add(callback)

			return { remove: () => this.listeners[event].delete(callback) }
		}

		public dispose(): void {
			disposals.pause++
		}
	}

	return {
		disposals,
		FakePauseSignal,
		sdk: {
			copyItems: vi.fn(),
			copyItemsTo: vi.fn()
		},
		epoch: { value: 0 },
		scope: { controller: new AbortController() },
		tracked: [] as Promise<unknown>[],
		enqueue: vi.fn(),
		flushNow: vi.fn(),
		markDirectorySizesStale: vi.fn(),
		trash: vi.fn(),
		account: {
			cached: vi.fn(),
			fetchFresh: vi.fn(),
			isCachedFresh: vi.fn()
		},
		addAccountStorageUsed: vi.fn()
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string, options?: { count?: number }) => `${key}:${options?.count ?? ""}` } }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: async () => ({ authedSdkClient: h.sdk }) } }))
vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: () => null,
	sdkErrorPartsToHumanReadable: (parts: { serverMessage?: string; innerMessage?: string }) => parts.serverMessage ?? parts.innerMessage ?? "error"
}))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: (item: { data: { uuid: string } }) => `name-${item.data.uuid}` }))
vi.mock("@/lib/cache", () => ({ default: { directoryUuidToAnySharedDirWithContext: new Map() } }))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null),
	unwrapDirMeta: (dir: unknown) => dir,
	unwrapFileMeta: (file: unknown) => file,
	unwrappedDirIntoDriveItem: (dir: { uuid: string; parent: string }) => ({ type: "directory", data: dir }),
	unwrappedFileIntoDriveItem: (file: { uuid: string; parent: string }) => ({ type: "file", data: file })
}))
vi.mock("@/lib/signals", () => ({
	PauseSignal: h.FakePauseSignal,
	wrapAbortSignalForSdk: (signal: AbortSignal) => ({ sdkAbortFor: signal }),
	disposeSdkAbortSignal: (signal: unknown) => {
		if (signal) {
			h.disposals.sdkAbort++
		}
	},
	createCompositeAbortSignal: (...signals: AbortSignal[]) => {
		const controller = new AbortController()

		for (const signal of signals) {
			signal.addEventListener("abort", () => controller.abort(), { once: true })
		}

		return Object.assign(controller.signal, {
			dispose: () => {
				h.disposals.composite++
			}
		})
	}
}))
vi.mock("@/features/transfers/transfers", () => ({
	default: {
		get sessionEpoch() {
			return h.epoch.value
		},
		copyScopeSignal: () => h.scope.controller.signal,
		trackCopy: (copy: Promise<unknown>) => {
			h.tracked.push(copy)
		}
	}
}))
vi.mock("@/features/drive/socketCreateBatcher", () => ({ default: { enqueue: h.enqueue, flushNow: h.flushNow } }))
vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({ markDirectorySizesStale: h.markDirectorySizesStale }))
vi.mock("@/features/drive/driveTrash", () => ({ trash: h.trash }))
vi.mock("@/queries/useAccount.query", () => ({ accountQuotaDeps: h.account, addAccountStorageUsed: h.addAccountStorageUsed }))

import copyRunner, { COPY_FLUSH_MS } from "@/features/copy/copyRunner"
import useCopyJobsStore, { getCopyJob } from "@/features/copy/store/useCopyJobs.store"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import copyActivity from "@/features/drive/copyActivity"
import { CopyPhase, CopyStage, ErrorKind, NonRootNormalItem_Tags } from "@/tests/mocks/sdkCopy"
import type { CopyItemsCallback, CopyReport, CopyUpdate } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

const DEST = { uuid: "dest", name: "Dest" }
const DEST_DIR = { tag: "Dir", inner: [{ uuid: "dest" }] } as never

const ZERO = {
	dirsCreated: 0n,
	dirsFailed: 0n,
	filesDone: 0n,
	filesFailed: 0n,
	bytesDone: 0n,
	bytesFailed: 0n,
	dirsNotAttempted: 0n,
	filesNotAttempted: 0n,
	bytesNotAttempted: 0n,
	entriesSkipped: 0n,
	bytesSkipped: 0n
}

function file(uuid: string): DriveItem {
	return { type: "file", data: { uuid, parent: "src" } } as unknown as DriveItem
}

function update(bytesDone: bigint, overrides: Partial<CopyUpdate> = {}): CopyUpdate {
	return {
		phase: CopyPhase.CopyingFiles,
		pausing: false,
		paused: false,
		cancelling: false,
		scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
		totals: { dirs: 0n, files: 1n, bytes: 1000n },
		counts: { ...ZERO, bytesDone },
		active: [],
		events: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		activeTimeMs: 0n,
		...overrides
	} as unknown as CopyUpdate
}

function createdFile(uuid: string, parent = "dest") {
	return { request: 0n, sourceUuid: `src-${uuid}`, item: { tag: NonRootNormalItem_Tags.File, inner: [{ uuid, parent }] } }
}

function report(overrides: Partial<Record<keyof CopyReport, unknown>> = {}): CopyReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 1n, bytes: 1000n },
		counts: { ...ZERO, filesDone: 1n, bytesDone: 1000n },
		error: undefined,
		...overrides
	} as unknown as CopyReport
}

type Script = (callback: CopyItemsCallback, managedFuture: { abortSignal: { sdkAbortFor: AbortSignal } }) => Promise<CopyReport>

function scriptCopy(script: Script): void {
	h.sdk.copyItems.mockImplementationOnce((_items, _dest, _options, callback, managedFuture) => script(callback, managedFuture))
}

async function runJob(items: DriveItem[] = [file("a")]): Promise<string> {
	const id = copyRunner.start({ items, destination: DEST, destinationDir: DEST_DIR }) as string

	await Promise.all(h.tracked)

	return id
}

beforeEach(() => {
	h.sdk.copyItems.mockReset()
	h.sdk.copyItemsTo.mockReset()
	h.enqueue.mockClear()
	h.flushNow.mockClear()
	h.markDirectorySizesStale.mockClear()
	h.trash.mockReset().mockResolvedValue(undefined)
	h.account.cached.mockReset().mockReturnValue({ storageUsed: 0n, maxStorage: 10_000n })
	h.account.fetchFresh.mockReset().mockResolvedValue({ storageUsed: 0n, maxStorage: 10_000n })
	h.account.isCachedFresh.mockReset().mockReturnValue(true)
	h.addAccountStorageUsed.mockClear()
	h.disposals.pause = 0
	h.disposals.sdkAbort = 0
	h.disposals.composite = 0
	h.tracked.length = 0
	h.epoch.value = 0
	h.scope.controller = new AbortController()
	useCopyJobsStore.getState().clear()
	useTransfersStore.setState({ transfers: [], finishedTransfers: [] })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("a copy job", () => {
	it("is one transfers row, never passes asyncOpts, and lands as one finished row", async () => {
		let rowsWhileRunning = 0

		scriptCopy(async callback => {
			rowsWhileRunning = useTransfersStore.getState().transfers.length
			callback.onUpdate(update(500n))

			return report()
		})

		const id = await runJob([file("a"), file("b"), file("c")])

		expect(rowsWhileRunning).toBe(1)
		expect(h.sdk.copyItems).toHaveBeenCalledOnce()
		// items, destination, options, callback, managedFuture — no sixth asyncOpts argument.
		expect(h.sdk.copyItems.mock.calls[0]).toHaveLength(5)
		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useTransfersStore.getState().finishedTransfers).toEqual([
			expect.objectContaining({ id, type: "copy", name: "copy_n_items:3", outcome: "succeeded", bytesTransferred: 1000 })
		])
		expect(copyActivity.isActive()).toBe(false)
	})

	it("hands created top-level items to the create batcher, writing no store from the callback", async () => {
		scriptCopy(async callback => {
			const jobsBefore = useCopyJobsStore.getState().jobs

			for (let i = 0; i < 5000; i++) {
				callback.onTopLevelCreated(createdFile(`c${i}`) as never)
			}

			// The callback only enqueues: no job store write per created item.
			expect(useCopyJobsStore.getState().jobs).toBe(jobsBefore)

			return report()
		})

		await runJob()

		expect(h.enqueue).toHaveBeenCalledTimes(5000)
		expect(h.enqueue.mock.calls[0]?.[0]).toEqual({
			parentUuid: "dest",
			item: { type: "file", data: { uuid: "c0", parent: "dest" } },
			recent: true
		})
		// Pending creates land before Recents is refreshed.
		expect(h.flushNow).toHaveBeenCalled()
	})

	it("writes progress at most once per window however fast updates come", async () => {
		vi.useFakeTimers()

		let writes = 0
		const unsubscribe = useCopyJobsStore.subscribe(() => {
			writes++
		})

		scriptCopy(async callback => {
			writes = 0

			// 1000 updates over one second.
			for (let i = 0; i < 1000; i++) {
				callback.onUpdate(update(BigInt(i)))
				vi.advanceTimersByTime(1)
			}

			const during = writes

			expect(during).toBeLessThanOrEqual(1000 / COPY_FLUSH_MS + 1)

			return report()
		})

		const id = copyRunner.start({ items: [file("a")], destination: DEST, destinationDir: DEST_DIR }) as string

		await vi.runAllTimersAsync()
		await Promise.all(h.tracked)

		unsubscribe()

		// Kept for its finished row ("Retry failed items"), with the settled figures.
		expect(getCopyJob(id)?.outcome).toEqual({ status: "done" })
		expect(getCopyJob(id)?.counts.bytesDone).toBe(1000)
	})

	it("swallows a throw inside a handler instead of failing the Rust call", async () => {
		scriptCopy(async callback => {
			expect(() => callback.onUpdate({ events: null } as unknown as CopyUpdate)).not.toThrow()
			expect(() => callback.onTopLevelCreated({ item: null } as never)).not.toThrow()

			return report()
		})

		await runJob()

		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("succeeded")
	})

	it.each([
		["succeeds", async () => report()],
		["is cancelled", async () => report({ error: { kind: ErrorKind.Cancelled, message: "", serverMessage: undefined } })],
		[
			"throws",
			async () => {
				throw new Error("boom")
			}
		]
	])("releases its SDK handles exactly once when it %s", async (_label, script) => {
		scriptCopy(script)

		await runJob()

		expect(h.disposals).toEqual({ pause: 1, sdkAbort: 1, composite: 1 })
		expect(copyActivity.isActive()).toBe(false)
	})

	it("settles storage and directory sizes from what it copied", async () => {
		scriptCopy(async () => report())

		await runJob()

		expect(h.addAccountStorageUsed).toHaveBeenCalledExactlyOnceWith(1000n)
		expect(h.markDirectorySizesStale).toHaveBeenCalledOnce()
	})

	it("a failed job shows its error on the finished row", async () => {
		scriptCopy(async () => report({ error: { kind: ErrorKind.Server, message: "inner", serverMessage: "Server says no" }, counts: ZERO }))

		await runJob()

		expect(useTransfersStore.getState().finishedTransfers[0]).toEqual(
			expect.objectContaining({ outcome: "errored", errorMessage: "Server says no" })
		)
		expect(h.addAccountStorageUsed).not.toHaveBeenCalled()
	})
})

describe("quota", () => {
	const preflightRefusal = () =>
		report({ error: { kind: ErrorKind.MaxStorageReached, message: "", serverMessage: undefined }, counts: ZERO, totals: { dirs: 0n, files: 0n, bytes: 0n } })

	it("a fresh cached account is trusted: no read", async () => {
		scriptCopy(async () => report())

		await runJob()

		expect(h.account.fetchFresh).not.toHaveBeenCalled()
		expect(h.sdk.copyItems.mock.calls[0]?.[2]).toEqual({ maxBytes: 10_000n })
	})

	it("a stale cached account is read once", async () => {
		h.account.isCachedFresh.mockReturnValue(false)
		h.account.fetchFresh.mockResolvedValue({ storageUsed: 1000n, maxStorage: 10_000n })
		scriptCopy(async () => report())

		await runJob()

		expect(h.account.fetchFresh).toHaveBeenCalledOnce()
		expect(h.sdk.copyItems.mock.calls[0]?.[2]).toEqual({ maxBytes: 9000n })
	})

	it("a refusal against the cached figure reads once and runs again when more is free", async () => {
		h.account.cached.mockReturnValue({ storageUsed: 9_999n, maxStorage: 10_000n })
		h.account.fetchFresh.mockResolvedValue({ storageUsed: 0n, maxStorage: 10_000n })
		scriptCopy(async () => preflightRefusal())
		scriptCopy(async () => report())

		await runJob()

		expect(h.account.fetchFresh).toHaveBeenCalledOnce()
		expect(h.sdk.copyItems).toHaveBeenCalledTimes(2)
		expect(h.sdk.copyItems.mock.calls[1]?.[2]).toEqual({ maxBytes: 10_000n })
		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("succeeded")
	})

	it("a refusal says what the scan needed and what is free; without a scanned total, the plain limit", async () => {
		h.account.isCachedFresh.mockReturnValue(false)
		h.account.fetchFresh.mockResolvedValue({ storageUsed: 9_000n, maxStorage: 10_000n })
		scriptCopy(async () =>
			report({
				error: { kind: ErrorKind.MaxStorageReached, message: "", serverMessage: undefined },
				counts: ZERO,
				totals: { dirs: 0n, files: 3n, bytes: 5000n }
			})
		)

		await runJob()

		expect(useTransfersStore.getState().finishedTransfers[0]?.errorMessage).toMatch(/^not_enough_storage/)

		scriptCopy(async () => preflightRefusal())

		await runJob()

		const rows = useTransfersStore.getState().finishedTransfers

		expect(rows).toHaveLength(2)
		expect(rows.at(-1)?.outcome).toBe("errored")
		expect(rows.at(-1)?.errorMessage).not.toMatch(/^not_enough_storage/)
	})

	it("a refusal against a figure just read fresh is final: no second read, no rerun", async () => {
		h.account.isCachedFresh.mockReturnValue(false)
		scriptCopy(async () => preflightRefusal())

		await runJob()

		expect(h.account.fetchFresh).toHaveBeenCalledOnce()
		expect(h.sdk.copyItems).toHaveBeenCalledOnce()
		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("errored")
	})

	it("no rerun after a cancel", async () => {
		h.account.cached.mockReturnValue({ storageUsed: 9_999n, maxStorage: 10_000n })
		scriptCopy(async () => {
			const id = Object.keys(useCopyJobsStore.getState().jobs)[0] as string

			copyRunner.requestCancel(id, "keep")

			return preflightRefusal()
		})

		await runJob()

		expect(h.sdk.copyItems).toHaveBeenCalledOnce()
	})
})

describe("cancel", () => {
	function cancelMidway(mode: "keep" | "trash" | "row"): Script {
		return async (callback, managedFuture) => {
			callback.onTopLevelCreated(createdFile("made") as never)

			const id = Object.keys(useCopyJobsStore.getState().jobs)[0] as string

			if (mode === "row") {
				useTransfersStore.getState().transfers[0]?.abort()
			} else {
				copyRunner.requestCancel(id, mode)
			}

			// The SDK sees the cancel through the managed future and still returns its report.
			expect(managedFuture.abortSignal.sdkAbortFor.aborted).toBe(true)

			return report({
				error: { kind: ErrorKind.Cancelled, message: "", serverMessage: undefined },
				topLevel: [createdFile("made"), createdFile("version-target")],
				failures: [
					{
						item: {},
						info: { stage: CopyStage.RegisteredAsVersion, existingFile: "version-target", error: { kind: ErrorKind.Server } }
					}
				]
			})
		}
	}

	it("keep: the row goes, nothing is trashed", async () => {
		scriptCopy(cancelMidway("keep"))

		await runJob()

		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useTransfersStore.getState().finishedTransfers).toEqual([])
		expect(h.trash).not.toHaveBeenCalled()
	})

	it("the row's generic abort is keep", async () => {
		scriptCopy(cancelMidway("row"))

		await runJob()

		expect(h.trash).not.toHaveBeenCalled()
	})

	it("trash: only the created top-level items, never a version target", async () => {
		scriptCopy(cancelMidway("trash"))

		await runJob()

		expect(h.trash).toHaveBeenCalledExactlyOnceWith({ item: { type: "file", data: { uuid: "made", parent: "dest" } } })
	})

	it("cancelAll / the background lifecycle (the scope) cancels as keep", async () => {
		scriptCopy(async () => {
			h.scope.controller.abort()

			return report({ error: { kind: ErrorKind.Cancelled, message: "", serverMessage: undefined }, topLevel: [createdFile("made")] })
		})

		await runJob()

		expect(h.trash).not.toHaveBeenCalled()
	})
})

describe("the stop dialog", () => {
	// A copy that waits mid-run until it is cancelled or let go, as the SDK does while paused.
	function heldCopy(): { started: Promise<void>; finish: () => void } {
		let markStarted = () => {}
		let finish = () => {}
		const started = new Promise<void>(resolve => {
			markStarted = resolve
		})

		scriptCopy(async (callback, managedFuture) => {
			const abort = managedFuture.abortSignal.sdkAbortFor

			callback.onTopLevelCreated(createdFile("made") as never)
			markStarted()

			await new Promise<void>(resolve => {
				finish = resolve
				abort.addEventListener("abort", () => resolve(), { once: true })
			})

			return abort.aborted
				? report({ error: { kind: ErrorKind.Cancelled, message: "", serverMessage: undefined }, topLevel: [createdFile("made")] })
				: report({ topLevel: [createdFile("made")] })
		})

		return {
			started,
			finish: () => finish()
		}
	}

	function startJob(): string {
		return copyRunner.start({ items: [file("a")], destination: DEST, destinationDir: DEST_DIR }) as string
	}

	function rowPaused(): boolean | undefined {
		return useTransfersStore.getState().transfers[0]?.paused
	}

	it("pauses the copy while open; continue resumes it and nothing is cancelled", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		expect(copyRunner.holdForCancelChoice(id)).toBe(true)
		expect(rowPaused()).toBe(true)

		await copyRunner.resolveCancelChoice(id, "continue", true)

		expect(rowPaused()).toBe(false)

		copy.finish()
		await Promise.all(h.tracked)

		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("succeeded")
		expect(h.trash).not.toHaveBeenCalled()
	})

	it("continue leaves a copy the user had paused paused", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		copyRunner.pause(id)

		const pausedHere = copyRunner.holdForCancelChoice(id)

		expect(pausedHere).toBe(false)

		await copyRunner.resolveCancelChoice(id, "continue", pausedHere)

		expect(rowPaused()).toBe(true)

		copyRunner.resume(id)
		copy.finish()
		await Promise.all(h.tracked)
	})

	it("stop and keep: the paused copy takes the stop, the row goes, nothing is trashed", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		copyRunner.pause(id)
		copyRunner.holdForCancelChoice(id)

		await copyRunner.resolveCancelChoice(id, "keep", false)
		await Promise.all(h.tracked)

		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useTransfersStore.getState().finishedTransfers).toEqual([])
		expect(h.trash).not.toHaveBeenCalled()
		expect(getCopyJob(id)).toBeUndefined()
	})

	it("move to trash: what the copy made goes to the trash", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		copyRunner.holdForCancelChoice(id)

		await copyRunner.resolveCancelChoice(id, "trash", true)
		await Promise.all(h.tracked)

		expect(h.trash).toHaveBeenCalledExactlyOnceWith({ item: { type: "file", data: { uuid: "made", parent: "dest" } } })
	})

	it("a copy stopped by Cancel all while the dialog is open still honours a trash answer, then is dropped", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		copyRunner.holdForCancelChoice(id)
		h.scope.controller.abort()
		await Promise.all(h.tracked)

		expect(h.trash).not.toHaveBeenCalled()
		expect(getCopyJob(id)?.created).toHaveLength(1)

		await copyRunner.resolveCancelChoice(id, "trash", true)

		expect(h.trash).toHaveBeenCalledOnce()
		expect(getCopyJob(id)).toBeUndefined()
	})

	it("a copy that finishes while the dialog is open: continue keeps everything and lets go of what it made", async () => {
		const copy = heldCopy()
		const id = startJob()

		await copy.started

		copyRunner.holdForCancelChoice(id)
		copyRunner.resume(id)
		copy.finish()
		await Promise.all(h.tracked)

		expect(getCopyJob(id)?.created).toHaveLength(1)

		await copyRunner.resolveCancelChoice(id, "continue", true)

		expect(h.trash).not.toHaveBeenCalled()
		expect(getCopyJob(id)?.created).toEqual([])
		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("succeeded")
	})
})

describe("retry and pause", () => {
	it("retries a job's failures through copyItemsTo, back into their planned directories", async () => {
		const failure = {
			item: { tag: "File", inner: [{}] },
			info: {
				sourceUuid: "s",
				sourcePath: "/x",
				destParent: "sub",
				destParentDir: { tag: "Dir", inner: [{ uuid: "sub" }] },
				destName: "x",
				stage: CopyStage.Upload,
				error: { kind: ErrorKind.Server, message: "", serverMessage: undefined },
				affectedFiles: 1n,
				affectedBytes: 1n,
				existingFile: undefined
			}
		}

		scriptCopy(async () => report({ failures: [failure] }))

		const id = await runJob()

		expect(useTransfersStore.getState().finishedTransfers[0]?.outcome).toBe("completedWithErrors")

		h.sdk.copyItemsTo.mockResolvedValueOnce(report())
		h.tracked.length = 0

		expect(copyRunner.retryFailed(id)).not.toBeNull()

		await Promise.all(h.tracked)

		expect(h.sdk.copyItemsTo).toHaveBeenCalledOnce()
		expect(h.sdk.copyItemsTo.mock.calls[0]?.[0]).toEqual([{ item: failure.item, destination: failure.info.destParentDir, name: "x" }])
		expect(h.sdk.copyItemsTo.mock.calls[0]).toHaveLength(4)
	})

	it("pause and resume from the row flip its paused flag", async () => {
		let pausedSeen: boolean | undefined
		let resumedSeen: boolean | undefined

		scriptCopy(async () => {
			const row = useTransfersStore.getState().transfers[0]

			row?.pause()
			pausedSeen = useTransfersStore.getState().transfers[0]?.paused
			row?.resume()
			resumedSeen = useTransfersStore.getState().transfers[0]?.paused

			return report()
		})

		await runJob()

		expect(pausedSeen).toBe(true)
		expect(resumedSeen).toBe(false)
	})
})

describe("logout mid-copy", () => {
	it("after the epoch moves, callbacks and settle make no batcher, account, size or trash write", async () => {
		scriptCopy(async callback => {
			const id = Object.keys(useCopyJobsStore.getState().jobs)[0] as string

			copyRunner.requestCancel(id, "trash")
			h.epoch.value++

			callback.onTopLevelCreated(createdFile("late") as never)
			callback.onUpdate(update(1000n))

			return report({ topLevel: [createdFile("late")] })
		})

		await runJob()

		expect(h.enqueue).not.toHaveBeenCalled()
		expect(h.flushNow).not.toHaveBeenCalled()
		expect(h.addAccountStorageUsed).not.toHaveBeenCalled()
		expect(h.markDirectorySizesStale).not.toHaveBeenCalled()
		expect(h.trash).not.toHaveBeenCalled()
		expect(useTransfersStore.getState().transfers).toEqual([])
		expect(useCopyJobsStore.getState().jobs).toEqual({})
		// Handles are still released and the activity count still drops.
		expect(h.disposals).toEqual({ pause: 1, sdkAbort: 1, composite: 1 })
		expect(copyActivity.isActive()).toBe(false)
	})
})
