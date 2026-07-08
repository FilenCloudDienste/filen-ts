import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { AnyFile, UuidStr, ZipItem } from "@filen/sdk-rs"
import type { DriveItem } from "@/lib/drive/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { FsaSaveTarget, SaveTarget, SwSaveTarget } from "@/lib/drive/save-download"

// Mock boundaries mirror lib/drive/download.test.ts's own: the worker client, save-download, query
// client, and sonner are all unresolvable/unwanted (or assertion-only) under node vitest.
const { downloadItemsToZip } = vi.hoisted(() => ({ downloadItemsToZip: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadItemsToZip } }))

const { saveDownloadMock, isPickerCancelledMock } = vi.hoisted(() => ({
	saveDownloadMock: vi.fn(),
	isPickerCancelledMock: vi.fn()
}))

vi.mock("@/lib/drive/save-download", () => ({ saveDownload: saveDownloadMock, isPickerCancelled: isPickerCancelledMock }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))

import {
	narrowToZipItems,
	runZipDownload,
	defaultZipDownloadDeps,
	startZipDownload,
	type RunZipDownloadDeps
} from "@/lib/drive/download-zip"
import { useTransfersStore, type Transfer, type TerminalStatus } from "@/stores/transfers"

const PARENT_UUID = "22222222-2222-2222-2222-222222222222" as UuidStr
let uuidCounter = 0

function nextUuid(): UuidStr {
	uuidCounter += 1

	return `${uuidCounter.toString().padStart(8, "0")}-0000-0000-0000-000000000000` as UuidStr
}

function fileItem(params: { uuid?: UuidStr; name?: string; size?: bigint } = {}): DriveItem {
	const uuid = params.uuid ?? nextUuid()
	const name = params.name ?? `file-${uuid}`
	const size = params.size ?? 1_024n

	return {
		type: "file",
		data: {
			uuid,
			parent: PARENT_UUID,
			size,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 1_700_000_000_000n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: { name, mime: "application/pdf", modified: 0n, size, key: "key", version: 2 } },
			undecryptable: false,
			decryptedMeta: { name, mime: "application/pdf", modified: 0n, size, key: "key", version: 2 }
		}
	}
}

function dirItem(params: { uuid?: UuidStr; name?: string } = {}): DriveItem {
	const uuid = params.uuid ?? nextUuid()
	const name = params.name ?? `dir-${uuid}`

	return {
		type: "directory",
		data: {
			uuid,
			parent: PARENT_UUID,
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name } },
			size: 0n,
			undecryptable: false,
			decryptedMeta: { name }
		}
	}
}

function testFile(overrides: Partial<AnyFile> = {}): AnyFile {
	return {
		uuid: nextUuid(),
		meta: { type: "encrypted", data: "ciphertext" },
		parent: PARENT_UUID,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

// Mirrors download.test.ts's own fsaWritable/fsaTarget doubles.
function fsaWritable(sink: UnderlyingSink<Uint8Array> = {}): FileSystemWritableFileStream {
	return Object.assign(new WritableStream<Uint8Array>(sink), {
		write: () => Promise.resolve(),
		seek: () => Promise.resolve(),
		truncate: () => Promise.resolve()
	})
}

const fsaTarget: SaveTarget = { kind: "fsa", writable: {} as FileSystemWritableFileStream }

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	saveDownloadMock.mockResolvedValue(fsaTarget)
	isPickerCancelledMock.mockReturnValue(false)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("narrowToZipItems", () => {
	it("maps a file item to its data (structurally an AnyFile)", () => {
		const item = fileItem({ name: "a.txt", size: 10n })

		const [zipItem] = narrowToZipItems([item])

		expect(zipItem).toEqual(item.data)
	})

	it("maps a directory item to its data (structurally an AnyDirWithContext via the AnyNormalDir=Dir arm)", () => {
		const item = dirItem({ name: "Documents" })

		const [zipItem] = narrowToZipItems([item])

		expect(zipItem).toEqual(item.data)
	})

	it("maps a mixed selection in order", () => {
		const file = fileItem({ name: "a.txt" })
		const dir = dirItem({ name: "Documents" })

		expect(narrowToZipItems([file, dir])).toEqual([file.data, dir.data])
	})

	it("returns an empty array for an empty selection", () => {
		expect(narrowToZipItems([])).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// runZipDownload — injected deps, no worker/query client; saveDownload/isPickerCancelled mocked at
// the module boundary (see the mock declarations above).
// ---------------------------------------------------------------------------

describe("runZipDownload (injected deps, save-download mocked)", () => {
	function makeHarness() {
		const downloadZip =
			vi.fn<
				(
					items: ZipItem[],
					transferId: string,
					save: SaveTarget,
					onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
				) => Promise<void>
			>()
		const add = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const setProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const setSize = vi.fn<(id: string, size: number) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const deps: RunZipDownloadDeps = { downloadZip, store: { add, setProgress, setSize, settle, remove } }

		return { deps, downloadZip, add, setProgress, setSize, settle, remove }
	}

	it("adds ONE downloading transfer (size 0, name = suggestedName) before calling downloadZip, regardless of selection size", async () => {
		const h = makeHarness()
		h.downloadZip.mockResolvedValue(undefined)

		await runZipDownload(h.deps, { items: [fileItem(), fileItem(), dirItem()], suggestedName: "Filen.zip" })

		expect(h.add).toHaveBeenCalledTimes(1)
		expect(h.add.mock.calls[0]?.[0]).toMatchObject({
			direction: "download",
			name: "Filen.zip",
			size: 0,
			bytesTransferred: 0,
			status: "downloading",
			parentUuid: null
		})
		expect(h.downloadZip).toHaveBeenCalledTimes(1)
	})

	it("passes the narrowed ZipItems (not the raw DriveItems) to downloadZip", async () => {
		const h = makeHarness()
		h.downloadZip.mockResolvedValue(undefined)
		const items = [fileItem(), dirItem()]

		await runZipDownload(h.deps, { items, suggestedName: "Filen.zip" })

		expect(h.downloadZip.mock.calls[0]?.[0]).toEqual(narrowToZipItems(items))
	})

	it("resolves the save target using the suggestedName", async () => {
		const h = makeHarness()
		h.downloadZip.mockResolvedValue(undefined)

		await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(saveDownloadMock).toHaveBeenCalledWith("Documents.zip")
	})

	it("calls saveDownload exactly once regardless of selection size (one dialog, not N)", async () => {
		const h = makeHarness()
		h.downloadZip.mockResolvedValue(undefined)

		await runZipDownload(h.deps, { items: [fileItem(), fileItem(), fileItem()], suggestedName: "Filen.zip" })

		expect(saveDownloadMock).toHaveBeenCalledTimes(1)
	})

	it("settles done on success (the SDK exposes no partial-failure signal)", async () => {
		const h = makeHarness()
		h.downloadZip.mockResolvedValue(undefined)

		const outcome = await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(outcome).toEqual({ status: "success" })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "done")
	})

	it("updates size from totalBytes and progress from bytesWritten on every progress tick", async () => {
		const h = makeHarness()
		h.downloadZip.mockImplementation((_items, _id, _save, onProgress) => {
			onProgress(512n, 2_048n, 1n, 4n)

			return Promise.resolve()
		})

		await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(h.setSize).toHaveBeenCalledWith(expect.any(String), 2_048)
		expect(h.setProgress).toHaveBeenCalledWith(expect.any(String), 512)
	})

	it("returns an error outcome and settles error on a non-cancel rejection", async () => {
		const h = makeHarness()
		const dto = sdkDto("Timeout")
		h.downloadZip.mockRejectedValue(dto)

		const outcome = await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "error", dto)
	})

	it("settles cancelled then removes the row on a Cancelled rejection, returning a clean success", async () => {
		const h = makeHarness()
		h.downloadZip.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(outcome).toEqual({ status: "success" })
		const id = h.settle.mock.calls[0]?.[0]
		expect(h.settle).toHaveBeenCalledWith(id, "cancelled")
		expect(h.remove).toHaveBeenCalledWith(id)
	})

	it("is a clean no-op (no store writes, no downloadZip call) when the user cancels the save picker", async () => {
		const h = makeHarness()
		saveDownloadMock.mockRejectedValue(new Error("aborted"))
		isPickerCancelledMock.mockReturnValue(true)

		const outcome = await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(outcome).toEqual({ status: "success" })
		expect(h.add).not.toHaveBeenCalled()
		expect(h.downloadZip).not.toHaveBeenCalled()
	})

	it("returns an error outcome (not a no-op) when saveDownload rejects for a real reason", async () => {
		const h = makeHarness()
		saveDownloadMock.mockRejectedValue(new Error("disk full"))
		isPickerCancelledMock.mockReturnValue(false)

		const outcome = await runZipDownload(h.deps, { items: [dirItem()], suggestedName: "Documents.zip" })

		expect(outcome.status).toBe("error")
		expect(h.add).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// defaultZipDownloadDeps.downloadZip — the real Comlink.transfer/Comlink.proxy + coordinated-teardown
// wiring, exercised against real WHATWG streams with only sdkApi.downloadItemsToZip mocked.
// ---------------------------------------------------------------------------

describe("defaultZipDownloadDeps.downloadZip — fsa branch", () => {
	it("pipes bytes written to the transferred writer through to the fsa sink, and forwards all 4 progress args", async () => {
		const written: Uint8Array[] = []
		const sinkAbort = vi.fn()
		const save: FsaSaveTarget = {
			kind: "fsa",
			writable: fsaWritable({ write: chunk => void written.push(chunk), abort: sinkAbort })
		}

		downloadItemsToZip.mockImplementation(
			async (
				_items: ZipItem[],
				_id: string,
				writer: WritableStream<Uint8Array>,
				onProgress: (bytesWritten: bigint, totalBytes: bigint, itemsProcessed: bigint, totalItems: bigint) => void
			) => {
				const w = writer.getWriter()
				await w.write(new Uint8Array([1, 2, 3]))
				onProgress(3n, 3n, 1n, 1n)
				await w.close()
			}
		)

		const onProgress = vi.fn()

		await defaultZipDownloadDeps.downloadZip([testFile()], "transfer-id", save, onProgress)

		expect(written).toEqual([new Uint8Array([1, 2, 3])])
		expect(onProgress).toHaveBeenCalledWith(3n, 3n, 1n, 1n)
		expect(sinkAbort).not.toHaveBeenCalled()
	})

	it("tears down (aborts) the fsa sink when the worker call rejects — coordinated teardown", async () => {
		const sinkAbort = vi.fn()
		const save: FsaSaveTarget = { kind: "fsa", writable: fsaWritable({ abort: sinkAbort }) }
		const dto = sdkDto("Cancelled")

		// Mirrors the SDK's own leave-writable-open-on-abort behavior: the worker call rejects without
		// ever closing the transferred writer.
		downloadItemsToZip.mockRejectedValue(dto)

		await expect(defaultZipDownloadDeps.downloadZip([testFile()], "transfer-id", save, vi.fn())).rejects.toEqual(dto)

		expect(sinkAbort).toHaveBeenCalledTimes(1)
	})
})

describe("defaultZipDownloadDeps.downloadZip — sw branch (guarded, unreachable via the FSA entry-point gates)", () => {
	it("rejects with a clear error instead of silently misdownloading", async () => {
		const save: SwSaveTarget = { kind: "sw", id: "id-1", url: "/sw/download/id-1", name: "Filen.zip" }

		await expect(defaultZipDownloadDeps.downloadZip([testFile()], "transfer-id", save, vi.fn())).rejects.toThrow(
			"zip over service worker not supported yet"
		)
		expect(downloadItemsToZip).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// startZipDownload — real runZipDownload + defaultZipDownloadDeps wiring.
// ---------------------------------------------------------------------------

describe("startZipDownload (real runZipDownload + defaultZipDownloadDeps)", () => {
	it("is a no-op for an empty selection", async () => {
		await startZipDownload([])

		expect(saveDownloadMock).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("suggests `${dirName}.zip` for a single directory", async () => {
		downloadItemsToZip.mockImplementation(async (_items: ZipItem[], _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startZipDownload([dirItem({ name: "Documents" })])

		expect(saveDownloadMock).toHaveBeenCalledWith("Documents.zip")
	})

	it("suggests a generic archive name for a multi-item selection", async () => {
		downloadItemsToZip.mockImplementation(async (_items: ZipItem[], _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startZipDownload([fileItem({ name: "a.txt" }), fileItem({ name: "b.txt" })])

		expect(saveDownloadMock).toHaveBeenCalledWith("Filen.zip")
	})

	it("produces no success toast on a successful zip (the transfer row is the signal)", async () => {
		downloadItemsToZip.mockImplementation(async (_items: ZipItem[], _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startZipDownload([dirItem()])

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("toasts a failure summary when the zip errors", async () => {
		downloadItemsToZip.mockRejectedValue(sdkDto("Timeout"))

		await startZipDownload([dirItem()])

		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("produces no toast when the user cancels the save picker", async () => {
		saveDownloadMock.mockRejectedValue(new Error("aborted"))
		isPickerCancelledMock.mockReturnValue(true)

		await startZipDownload([dirItem()])

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("registers one done transfer in the real transfers store for a successful zip", async () => {
		downloadItemsToZip.mockImplementation(async (_items: ZipItem[], _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startZipDownload([dirItem({ name: "Documents" })])

		const transfers = useTransfersStore.getState().transfers
		expect(transfers).toHaveLength(1)
		expect(transfers[0]).toMatchObject({ direction: "download", status: "done", name: "Documents.zip" })
	})
})
