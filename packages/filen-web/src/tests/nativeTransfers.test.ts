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
				setPaused: vi.fn(),
				download: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
					Promise.resolve({ ok: true, value: { status: "started", ids: ["x"] } })
				),
				upload: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
					Promise.resolve({ ok: true, value: { status: "started", ids: ["x"], skipped: [] } })
				),
				pickUpload: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
					Promise.resolve({ ok: true, value: { status: "canceled" } })
				)
			}
		},
		emit: (event: unknown) => {
			listener?.(event)
		}
	}
})

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => bridge }))

const { landUpload, invalidateUploadedDirectorySizes, reactToStorageRefusal, patchCreated, markAccountStale, startUploads } = vi.hoisted(
	() => ({
		startUploads: vi.fn((_files: File[], _parentUuid: string | null) => Promise.resolve()),
		landUpload: vi.fn(),
		invalidateUploadedDirectorySizes: vi.fn(),
		reactToStorageRefusal: vi.fn(),
		patchCreated: vi.fn(),
		markAccountStale: vi.fn()
	})
)

vi.mock("@/features/drive/lib/upload", () => ({
	startUploads,
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

const { startDirectoryUpload, ensureUploadQuota, convertPreference, findCachedListingItem } = vi.hoisted(() => ({
	startDirectoryUpload: vi.fn((_input: unknown, _parentUuid: string | null) => Promise.resolve()),
	ensureUploadQuota: vi.fn((_bytes: bigint) => Promise.resolve(true)),
	convertPreference: { on: false },
	findCachedListingItem: vi.fn((_uuid: string): unknown => undefined)
}))

vi.mock("@/features/drive/lib/uploadDirectory", () => ({
	startDirectoryUpload,
	isDirectoryEntry: (entry: FileSystemEntry) => entry.isDirectory,
	readEntriesBatch: (reader: FileSystemDirectoryReader) =>
		new Promise<FileSystemEntry[]>((resolve, reject) => {
			reader.readEntries(resolve, reject)
		})
}))
vi.mock("@/features/drive/lib/quota", () => ({ ensureUploadQuota }))
vi.mock("@/features/drive/lib/heicUpload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/heicUpload")>()

	return {
		...actual,
		defaultHeicUploadDeps: { ...actual.defaultHeicUploadDeps, readPreference: () => Promise.resolve(convertPreference.on) }
	}
})
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	findCachedListingItem
}))
const account = vi.hoisted(() => ({ loaded: true }))

vi.mock("@/queries/account", () => ({ accountQueryGet: () => (account.loaded ? { rootDirUuid: ROOT } : undefined) }))

import { readFileSync } from "node:fs"
import { parseEnvelope } from "@filen/shared/session"
import { ubrnOf } from "@filen/shared/sdkShapes"
import {
	applyNativeEvent,
	pickNativeUpload,
	startNativeDrop,
	startNativeTransfersFeed,
	startNativeUploads
} from "@/features/transfers/lib/nativeTransfers"
import { nativeTransfersAvailable, startNativeDownloads } from "@/features/transfers/lib/nativeHost"
import { downloadItemOf, errorDtoOf, uploadParentOf } from "@/features/transfers/lib/nativeTransfers.logic"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { mockSharedFile, mockSharedRootDir } from "@/tests/fixtures/sdk"
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
	convertPreference.on = false
	account.loaded = true
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

	it("failed downloads of one group show one toast", () => {
		applyNativeEvent({
			t: "added",
			transfers: [native(), native({ id: testUuid("b"), name: "b.txt" }), native({ id: testUuid("c"), name: "c.txt" })]
		})
		applyNativeEvent({ t: "settled", id: testUuid("a"), outcome: "error", error: { code: "localFull" } })
		applyNativeEvent({ t: "settled", id: testUuid("b"), outcome: "error", error: { code: "localFull" } })

		expect(toastError).not.toHaveBeenCalled()

		applyNativeEvent({ t: "settled", id: testUuid("c"), outcome: "done" })

		expect(toastError).toHaveBeenCalledOnce()
	})

	it("after the feed restarts, a snapshot's known rows end their group as before", () => {
		const group = testUuid("g")

		applyNativeEvent({
			t: "added",
			transfers: [
				native({ id: testUuid("f1"), direction: "upload", group, parentUuid: PARENT, revealable: false }),
				native({ id: testUuid("f2"), direction: "upload", group, parentUuid: PARENT, revealable: false })
			]
		})
		stopFeed()
		stopFeed = startNativeTransfersFeed()
		emit({
			t: "snapshot",
			transfers: [
				native({ id: testUuid("f1"), direction: "upload", group, parentUuid: PARENT, revealable: false }),
				native({ id: testUuid("f2"), direction: "upload", group, parentUuid: PARENT, revealable: false })
			]
		} satisfies DesktopTransferEvent)
		applyNativeEvent({ t: "settled", id: testUuid("f1"), outcome: "done" })

		expect(toastSuccess).not.toHaveBeenCalled()

		applyNativeEvent({ t: "settled", id: testUuid("f2"), outcome: "done" })

		expect(toastSuccess).toHaveBeenCalledOnce()
		expect(invalidateUploadedDirectorySizes).toHaveBeenCalledWith(PARENT, [])
		expect(useTransfersStore.getState().uploadBatches).toEqual({})
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

function fileDriveItem(name = "a.txt"): DriveItem {
	return narrowItem(sdkFile(testUuid(name), 10n))
}

function dirDriveItem(): DriveItem {
	return narrowItem({
		uuid: testUuid("dir"),
		parent: PARENT,
		color: "default",
		timestamp: 3n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Photos", created: 1n } }
	} as never)
}

function localFile(name: string, size = 4): File {
	return new File([new Uint8Array(size)], name)
}

describe("native entry points: downloads", () => {
	it("sends wire items with their variant, the SDK value only, that the host's converter takes", () => {
		const items = [fileDriveItem(), dirDriveItem(), narrowItem(mockSharedFile()), narrowItem(mockSharedRootDir())]
		const wire = items.map(downloadItemOf)

		expect(wire.map(item => [item.kind, item.ref.variant, item.name])).toEqual([
			["file", "AnyFile.File", "a.txt"],
			["directory", "AnyDirWithContext.Normal.Dir", "Photos"],
			["file", "AnyFile.Shared", "shared.pdf"],
			["directory", "AnyDirWithContext.Shared.Root", "SharedRoot"]
		])

		for (const item of wire) {
			expect(() => ubrnOf(item.ref.variant, parseEnvelope(item.ref.value))).not.toThrow()
		}

		expect(Object.keys(parseEnvelope(wire[0]?.ref.value ?? "") as object)).not.toContain("decryptedMeta")
	})

	it("startNativeDownloads asks the host once and says it started", async () => {
		const items = [fileDriveItem(), dirDriveItem()]

		bridge.transfers.download.mockResolvedValueOnce({ ok: true, value: { status: "started", ids: ["x", "y"] } })
		await startNativeDownloads(items, { ask: true })

		expect(bridge.transfers.download).toHaveBeenCalledWith(items.map(downloadItemOf), { ask: true })
		expect(toastTransferStarted).toHaveBeenCalledWith({ direction: "download", name: "a.txt", count: 2, noun: "items" })
	})

	it("a canceled dialog says nothing; a failure says why", async () => {
		bridge.transfers.download.mockResolvedValueOnce({ ok: true, value: { status: "canceled" } })
		await startNativeDownloads([fileDriveItem()])
		bridge.transfers.download.mockResolvedValueOnce({ ok: false, error: { code: "localDenied" } })
		await startNativeDownloads([fileDriveItem()])

		expect(toastTransferStarted).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("Filen isn't allowed to read or write there.", expect.anything())
	})

	it("a failed start of several items shows one toast for its rows and the failure", async () => {
		const group = testUuid("g")

		bridge.transfers.download.mockImplementationOnce(() => {
			emit({
				t: "added",
				transfers: [native({ group }), native({ id: testUuid("b"), name: "b.txt", group })]
			} satisfies DesktopTransferEvent)

			for (const id of [testUuid("a"), testUuid("b")]) {
				emit({ t: "settled", id, outcome: "error", error: { code: "hostUnavailable" } } satisfies DesktopTransferEvent)
			}

			return Promise.resolve({ ok: false, error: { code: "hostUnavailable" } })
		})
		await startNativeDownloads([fileDriveItem(), fileDriveItem("b.txt")])

		const toastIds = new Set(toastError.mock.calls.map(([, options]) => (options as { id?: string } | undefined)?.id))

		expect(toastError).toHaveBeenCalled()
		expect([...toastIds]).toEqual([expect.any(String)])
	})

	it("public-link, archive-entry and Download as downloads stay on the web path", () => {
		for (const file of [
			"features/publicLinks/lib/download.ts",
			"features/archive/lib/entryDownload.ts",
			"features/drive/lib/downloadAs.ts"
		]) {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")

			expect(source).not.toMatch(/nativeTransfers|startDownloads|desktopBridge/)
		}
	})
})

describe("native entry points: uploads", () => {
	it("a parent is the held Dir, else a uuid-only Root, and the root is the account's", () => {
		const held = dirDriveItem()

		const parent = uploadParentOf(held.data.uuid, held)

		expect(parent.ref.variant).toBe("AnyNormalDir.Dir")
		expect(() => ubrnOf("AnyNormalDir.Dir", parseEnvelope(parent.ref.value))).not.toThrow()
		expect(uploadParentOf(PARENT, undefined)).toEqual({
			uuid: PARENT,
			ref: { variant: "AnyNormalDir.Root", value: stringifyEnvelope({ uuid: PARENT }) }
		})
	})

	it("sends HEIC candidates the web path only when conversion is on", async () => {
		const files = [localFile("a.heic"), localFile("b.txt")]

		await startNativeUploads(files, PARENT)

		expect(bridge.transfers.upload).toHaveBeenLastCalledWith(files, expect.objectContaining({ uuid: PARENT }))
		expect(startUploads).not.toHaveBeenCalled()

		convertPreference.on = true
		await startNativeUploads(files, PARENT)

		expect(bridge.transfers.upload).toHaveBeenLastCalledWith([files[1]], expect.objectContaining({ uuid: PARENT }))
		expect(startUploads).toHaveBeenCalledWith([files[0]], PARENT)
	})

	it("the root uploads into the account's root directory", async () => {
		await startNativeUploads([localFile("b.txt")], null)

		expect(bridge.transfers.upload).toHaveBeenCalledWith([expect.any(File)], expect.objectContaining({ uuid: ROOT }))
	})

	it("plain files keep the quota check", async () => {
		ensureUploadQuota.mockResolvedValueOnce(false)
		await startNativeUploads([localFile("b.txt", 7)], PARENT)

		expect(ensureUploadQuota).toHaveBeenCalledWith(7n)
		expect(bridge.transfers.upload).not.toHaveBeenCalled()
	})

	it("a picked directory holding a HEIC file uploads via the web walk when conversion is on", async () => {
		const files = [localFile("a.heic"), localFile("b.txt")]

		convertPreference.on = true
		await startNativeUploads(files, PARENT, { asDirectory: true })

		expect(startDirectoryUpload).toHaveBeenCalledWith({ kind: "files", files }, PARENT)
		expect(bridge.transfers.upload).not.toHaveBeenCalled()
	})

	it("a picked directory without HEIC files uploads natively as one directory", async () => {
		const files = [localFile("a.txt"), localFile("b.txt")]

		convertPreference.on = true
		await startNativeUploads(files, PARENT, { asDirectory: true })

		expect(bridge.transfers.upload).toHaveBeenCalledWith(files, expect.objectContaining({ uuid: PARENT }), { asDirectory: true })
		expect(startDirectoryUpload).not.toHaveBeenCalled()
		expect(ensureUploadQuota).not.toHaveBeenCalled()
	})

	it("skipped Files upload via the web path", async () => {
		const files = [localFile("a.txt"), localFile("b.txt")]

		bridge.transfers.upload.mockResolvedValueOnce({ ok: true, value: { status: "started", ids: ["x"], skipped: [1] } })
		await startNativeUploads(files, PARENT)

		expect(startUploads).toHaveBeenCalledWith([files[1]], PARENT)

		bridge.transfers.upload.mockResolvedValueOnce({ ok: true, value: { status: "started", ids: [], skipped: [0, 1] } })
		await startNativeUploads(files, PARENT, { asDirectory: true })

		expect(startDirectoryUpload).toHaveBeenCalledWith({ kind: "files", files }, PARENT)
	})

	it("pickNativeUpload opens the host's dialog into the parent and says when it started", async () => {
		bridge.transfers.pickUpload.mockResolvedValueOnce({ ok: true, value: { status: "started", ids: ["x", "y"] } })
		await pickNativeUpload("directory", PARENT)

		expect(bridge.transfers.pickUpload).toHaveBeenCalledWith("directory", expect.objectContaining({ uuid: PARENT }))
		expect(toastTransferStarted).toHaveBeenCalledWith({ direction: "upload", name: "", count: 2, noun: "items" })
	})

	it("says why nothing uploads while the account's root directory is unknown", async () => {
		account.loaded = false

		await pickNativeUpload("file", null)
		await startNativeUploads([localFile("a.txt")], null)
		await startNativeUploads([localFile("a.txt")], null, { asDirectory: true })

		expect(bridge.transfers.pickUpload).not.toHaveBeenCalled()
		expect(bridge.transfers.upload).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(3)
	})
})

// A dropped directory entry whose tree reads as `names` (one level), and that fails the test if walked when `walkable` is false.
function directoryEntry(name: string, names: string[], walkable = true): FileSystemDirectoryEntry {
	return {
		name,
		isDirectory: true,
		isFile: false,
		createReader: () => {
			if (!walkable) {
				throw new Error("walked")
			}

			let read = false

			return {
				readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
					resolve(read ? [] : names.map(child => ({ name: child, isDirectory: false, isFile: true }) as FileSystemEntry))
					read = true
				}
			}
		}
	} as unknown as FileSystemDirectoryEntry
}

describe("native entry points: drops", () => {
	it("a dropped directory goes to the bridge as its top-level File without walking entries when conversion is off", async () => {
		const top = localFile("Photos", 0)

		await startNativeDrop([top], [directoryEntry("Photos", [], false)], PARENT)

		expect(bridge.transfers.upload).toHaveBeenCalledWith([top], expect.objectContaining({ uuid: PARENT }))
		expect(startDirectoryUpload).not.toHaveBeenCalled()
	})

	it("with conversion on, a dropped directory without HEIC files goes native through its top-level File; one with a HEIC file takes the web walk", async () => {
		const plain = localFile("Docs", 0)
		const photos = localFile("Photos", 0)
		const photosEntry = directoryEntry("Photos", ["a.txt", "b.HEIC"])

		convertPreference.on = true
		await startNativeDrop([plain, photos], [directoryEntry("Docs", ["a.txt"]), photosEntry], PARENT)

		expect(bridge.transfers.upload).toHaveBeenCalledWith([plain], expect.objectContaining({ uuid: PARENT }))
		expect(startDirectoryUpload).toHaveBeenCalledWith({ kind: "entries", entries: [photosEntry] }, PARENT)
	})
})
