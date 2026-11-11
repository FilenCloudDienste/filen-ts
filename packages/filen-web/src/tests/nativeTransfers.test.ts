import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import type { DesktopTransfer, DesktopTransferEvent } from "@filen/shared/desktop"
import { stringifyEnvelope } from "@filen/shared/session"
import { testUuid } from "@/tests/support/uuid"

const { bridge, emit } = vi.hoisted(() => {
	let listener: ((event: unknown) => void) | undefined

	return {
		bridge: {
			transfers: {
				onEvents: (callback: (event: unknown) => void) => {
					listener = callback

					return () => {
						listener = undefined
					}
				},
				cancel: vi.fn(),
				setPaused: vi.fn()
			}
		},
		emit: (event: unknown) => {
			listener?.(event)
		}
	}
})

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => bridge }))

const { landUpload, invalidateUploadedDirectorySizes, reactToStorageRefusal, patchCreated, markAccountStale } = vi.hoisted(() => ({
	landUpload: vi.fn(),
	invalidateUploadedDirectorySizes: vi.fn(),
	reactToStorageRefusal: vi.fn(),
	patchCreated: vi.fn(),
	markAccountStale: vi.fn()
}))

vi.mock("@/features/drive/lib/upload", () => ({
	landUpload,
	invalidateUploadedDirectorySizes,
	reactToStorageRefusal,
	defaultUploadDeps: { patchCreated, markAccountStale },
	newUploadBatchRef: (parentUuid: string | null, directoryName?: string, id = "random") => ({
		id,
		parentUuid: parentUuid === ROOT ? null : parentUuid,
		...(directoryName === undefined ? {} : { directoryName })
	})
}))

const { toastSuccess, toastError, toastTransferStarted } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastTransferStarted: vi.fn()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/features/transfers/lib/transferStartToast", () => ({ toastTransferStarted }))

import { applyNativeEvent, nativeTransfersAvailable, startNativeTransfersFeed } from "@/features/transfers/lib/nativeTransfers"
import { errorDtoOf } from "@/features/transfers/lib/nativeTransfers.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

const ROOT = testUuid("root")
const PARENT = testUuid("parent")

function native(overrides: Partial<DesktopTransfer> = {}): DesktopTransfer {
	return {
		id: testUuid("a"),
		direction: "download",
		kind: "file",
		origin: "page",
		group: testUuid("group"),
		name: "a.txt",
		parentUuid: null,
		size: 100,
		bytes: 0,
		files: null,
		paused: false,
		startedAt: 5,
		revealable: true,
		...overrides
	}
}

function sdkFile(uuid: string, size: bigint): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		parent: PARENT,
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 3n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "a.txt", mime: "text/plain", created: 1n, modified: 2n, size, key: "k", version: 2 } }
	} as unknown as SdkFile
}

function rows() {
	return useTransfersStore.getState().transfers
}

let stopFeed: () => void = () => undefined

beforeEach(() => {
	vi.clearAllMocks()
	stopFeed()
	useTransfersStore.setState({ transfers: [], uploadBatches: {}, speedSamples: [], rowSpeedSamples: {}, batchSpeedSamples: {} })
	stopFeed = startNativeTransfersFeed()
})

describe("native transfers feed", () => {
	it("is available once started and idempotent", () => {
		expect(nativeTransfersAvailable()).toBe(true)
		expect(startNativeTransfersFeed()).toBe(stopFeed)
		stopFeed()
		expect(nativeTransfersAvailable()).toBe(false)
		stopFeed = startNativeTransfersFeed()
	})

	it("added downloads become native download rows with the item's size", () => {
		emit({ t: "added", transfers: [native({ size: 4096 })] } satisfies DesktopTransferEvent)

		expect(rows()).toEqual([
			{
				id: testUuid("a"),
				direction: "download",
				name: "a.txt",
				size: 4096,
				bytesTransferred: 0,
				status: "downloading",
				paused: false,
				parentUuid: null,
				startedAt: 5,
				native: true,
				revealable: true
			}
		])
		expect(toastTransferStarted).not.toHaveBeenCalled()
	})

	it("a drag's download says it started", () => {
		emit({ t: "added", transfers: [native({ origin: "drag", revealable: false })] } satisfies DesktopTransferEvent)

		expect(toastTransferStarted).toHaveBeenCalledWith({ direction: "download", name: "a.txt", count: 1, noun: "items" })
	})

	it("a files group becomes one upload run with a row per file; a directory upload becomes its own run row", () => {
		const group = testUuid("g")

		applyNativeEvent({
			t: "added",
			transfers: [
				native({ id: testUuid("f1"), direction: "upload", group, parentUuid: PARENT, size: 10, revealable: false }),
				native({ id: testUuid("f2"), direction: "upload", group, parentUuid: PARENT, size: 20, revealable: false }),
				native({
					id: testUuid("d"),
					direction: "upload",
					kind: "directory",
					group,
					name: "Photos",
					parentUuid: PARENT,
					size: 0,
					revealable: false
				})
			]
		})

		const { uploadBatches } = useTransfersStore.getState()

		expect(uploadBatches[group]).toMatchObject({ ref: { id: group, parentUuid: PARENT, native: true }, files: 2, bytes: 30 })
		expect(uploadBatches[testUuid("d")]).toMatchObject({
			ref: { id: testUuid("d"), parentUuid: PARENT, directoryName: "Photos", native: true },
			scanning: true
		})
		expect(rows().map(row => [row.id, row.batch?.id, row.native])).toEqual([
			[testUuid("d"), testUuid("d"), true],
			[testUuid("f1"), group, true],
			[testUuid("f2"), group, true]
		])
	})

	it("a progress event writes the store once", () => {
		applyNativeEvent({ t: "added", transfers: [native(), native({ id: testUuid("b"), name: "b.txt" })] })

		const listener = vi.fn()
		const unsubscribe = useTransfersStore.subscribe(listener)

		applyNativeEvent({
			t: "progress",
			updates: [
				{ id: testUuid("a"), size: 100, bytes: 40, files: null },
				{ id: testUuid("b"), size: 120, bytes: 10, files: null }
			]
		})
		unsubscribe()

		expect(listener).toHaveBeenCalledOnce()
		expect(rows().map(row => [row.size, row.bytesTransferred])).toEqual([
			[100, 40],
			[120, 10]
		])
	})

	it("the first progress with files clears a directory run's scanning and sets its totals", () => {
		const id = testUuid("d")

		applyNativeEvent({
			t: "added",
			transfers: [native({ id, direction: "upload", kind: "directory", name: "Photos", parentUuid: PARENT, size: 0 })]
		})
		applyNativeEvent({
			t: "progress",
			updates: [{ id, size: 1000, bytes: 300, files: { total: 10, done: 3, failed: 1, failedBytes: 100 } }]
		})

		expect(useTransfersStore.getState().uploadBatches[id]).toMatchObject({
			files: 10,
			settledFiles: 4,
			failed: 1,
			failedBytes: 100,
			bytes: 1000,
			transferred: 300
		})
		expect(useTransfersStore.getState().uploadBatches[id]?.scanning).toBeUndefined()
		expect(rows()[0]).toMatchObject({ size: 900, bytesTransferred: 300 })
	})

	it("a settled upload patches the listing with the decoded File and adds storage used", () => {
		const id = testUuid("f1")

		applyNativeEvent({ t: "added", transfers: [native({ id, direction: "upload", parentUuid: PARENT, revealable: false })] })
		applyNativeEvent({
			t: "settled",
			id,
			outcome: "done",
			uploaded: stringifyEnvelope(sdkFile(testUuid("new"), 9_007_199_254_740_993n))
		})

		const [, parentUuid, uploaded] = landUpload.mock.calls[0] as [unknown, string | null, SdkFile]

		expect(parentUuid).toBe(PARENT)
		expect(uploaded.size).toBe(9_007_199_254_740_993n)
		expect(rows()[0]).toMatchObject({ status: "done", item: { type: "file", data: { uuid: testUuid("new") } } })
		expect(invalidateUploadedDirectorySizes).toHaveBeenCalledWith(PARENT, [])
		expect(toastSuccess).toHaveBeenCalledOnce()
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})

	it("a settled directory upload patches its Dir into the parent and marks its size", () => {
		const id = testUuid("d")
		const dir = {
			uuid: testUuid("newdir"),
			parent: PARENT,
			color: "default",
			timestamp: 3n,
			favorited: false,
			meta: { type: "decoded", data: { name: "Photos", created: 1n } }
		}

		applyNativeEvent({
			t: "added",
			transfers: [native({ id, direction: "upload", kind: "directory", name: "Photos", parentUuid: ROOT, size: 0 })]
		})
		applyNativeEvent({ t: "progress", updates: [{ id, size: 50, bytes: 50, files: { total: 2, done: 2, failed: 0, failedBytes: 0 } }] })
		applyNativeEvent({ t: "settled", id, outcome: "done", uploaded: stringifyEnvelope(dir) })

		expect(patchCreated).toHaveBeenCalledWith(null, expect.objectContaining({ type: "directory" }))
		expect(markAccountStale).toHaveBeenCalled()
		expect(invalidateUploadedDirectorySizes).toHaveBeenCalledWith(null, [testUuid("newdir")])
		expect(rows()[0]).toMatchObject({ status: "done", size: 50, item: { type: "directory" } })
	})

	it("cancelled rows are removed, error rows keep a label from the code", () => {
		applyNativeEvent({ t: "added", transfers: [native(), native({ id: testUuid("b"), name: "b.txt" })] })
		applyNativeEvent({ t: "settled", id: testUuid("a"), outcome: "cancelled" })
		applyNativeEvent({ t: "settled", id: testUuid("b"), outcome: "error", error: { code: "localFull" } })

		expect(rows()).toHaveLength(1)
		expect(rows()[0]).toMatchObject({ id: testUuid("b"), status: "error", error: { message: "The disk is full." } })
		expect(toastError).toHaveBeenCalledOnce()
	})

	it("a storage refusal reacts once per group", () => {
		const group = testUuid("g")

		applyNativeEvent({
			t: "added",
			transfers: [
				native({ id: testUuid("f1"), direction: "upload", group, parentUuid: PARENT }),
				native({ id: testUuid("f2"), direction: "upload", group, parentUuid: PARENT })
			]
		})
		applyNativeEvent({ t: "settled", id: testUuid("f1"), outcome: "error", error: { code: "storageFull" } })
		applyNativeEvent({ t: "settled", id: testUuid("f2"), outcome: "error", error: { code: "storageFull" } })

		expect(reactToStorageRefusal).toHaveBeenCalledOnce()
		expect(rows()[0]?.error?.kind).toBe("MaxStorageReached")
	})

	it("cancelling a scanning native directory run keeps its row until settled", async () => {
		const id = testUuid("d")
		const { cancelTransfers } = await import("@/features/transfers/lib/control")

		applyNativeEvent({
			t: "added",
			transfers: [native({ id, direction: "upload", kind: "directory", name: "Photos", parentUuid: PARENT, size: 0 })]
		})
		cancelTransfers([id])

		expect(bridge.transfers.cancel).toHaveBeenCalledWith([id])
		expect(rows()).toHaveLength(1)

		applyNativeEvent({ t: "settled", id, outcome: "cancelled" })

		expect(rows()).toEqual([])
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})

	it("snapshot after a reload restores running rows and their upload runs and drops ended ones", () => {
		const group = testUuid("g")

		applyNativeEvent({ t: "added", transfers: [native({ id: testUuid("gone") })] })
		applyNativeEvent({
			t: "snapshot",
			transfers: [
				native({ id: testUuid("f1"), direction: "upload", group, parentUuid: PARENT, size: 10, bytes: 4, paused: true }),
				native({ id: testUuid("dl"), bytes: 30 })
			]
		})

		expect(rows().map(row => [row.id, row.bytesTransferred, row.paused])).toEqual([
			[testUuid("f1"), 4, true],
			[testUuid("dl"), 30, false]
		])
		expect(useTransfersStore.getState().uploadBatches[group]).toMatchObject({ files: 1, bytes: 10, transferred: 4 })

		applyNativeEvent({ t: "snapshot", transfers: [native({ id: testUuid("dl"), bytes: 60, paused: true })] })

		expect(rows().map(row => [row.id, row.bytesTransferred, row.paused])).toEqual([[testUuid("dl"), 60, true]])
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
	})

	it("a finished native row survives a later snapshot", () => {
		applyNativeEvent({ t: "added", transfers: [native()] })
		applyNativeEvent({ t: "settled", id: testUuid("a"), outcome: "done" })
		applyNativeEvent({ t: "snapshot", transfers: [] })

		expect(rows()).toMatchObject([{ id: testUuid("a"), status: "done" }])
	})
})

describe("errorDtoOf", () => {
	it("labels local failures in the page's words and keeps SDK kinds", () => {
		expect(errorDtoOf({ code: "interrupted" }).message).toBe("Stopped because the desktop app's background process quit.")
		expect(errorDtoOf({ code: "unknown", kind: "Io", message: "boom" })).toEqual({
			species: "plain",
			kind: "Io",
			label: "boom",
			message: "boom"
		})
		expect(errorDtoOf({ code: "storageFull" }).kind).toBe("MaxStorageReached")
	})
})
