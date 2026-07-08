import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { AnyFile, UuidStr } from "@filen/sdk-rs"
import type { DriveItem } from "@/lib/drive/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { FsaSaveTarget, SaveTarget, SwSaveTarget } from "@/lib/drive/save-download"

// Mock boundaries mirror lib/drive/upload.test.ts's own mock boundary: the worker client and query
// client are unresolvable/unwanted under node vitest, and sonner is mocked to assert the summary
// toast without a mounted <Toaster/>. lib/drive/save-download.ts is ALSO mocked here — runDownload
// calls its real `saveDownload`/`isPickerCancelled` directly (they are not part of RunDownloadDeps),
// so this file controls them the same way it controls the sdk client; save-download.test.ts is
// where saveDownload's OWN mechanism-picking and SW-protocol correctness are proven.
const { downloadFileToWriter, cancelDownload, toStringified } = vi.hoisted(() => ({
	downloadFileToWriter: vi.fn(),
	cancelDownload: vi.fn(),
	toStringified: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadFileToWriter, cancelDownload, toStringified } }))

const { saveDownloadMock, isPickerCancelledMock, triggerSwDownloadMock } = vi.hoisted(() => ({
	saveDownloadMock: vi.fn(),
	isPickerCancelledMock: vi.fn(),
	triggerSwDownloadMock: vi.fn()
}))

vi.mock("@/lib/drive/save-download", () => ({
	saveDownload: saveDownloadMock,
	isPickerCancelled: isPickerCancelledMock,
	triggerSwDownload: triggerSwDownloadMock
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))

// The real zip orchestration (runZipDownload/narrowToZipItems/etc.) lives in, and is unit-tested by,
// download-zip.test.ts — this file only needs to prove startDownloads ROUTES to it, so the whole
// module is replaced with a spy rather than exercising the real zip path here too.
const { startZipDownloadMock } = vi.hoisted(() => ({ startZipDownloadMock: vi.fn() }))

vi.mock("@/lib/drive/download-zip", () => ({ startZipDownload: startZipDownloadMock }))

import { runDownload, narrowToAnyFile, defaultDownloadDeps, startDownloads, needsZip, type RunDownloadDeps } from "@/lib/drive/download"
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

// A real WritableStream (so pipeTo's teardown/close semantics are the genuine WHATWG behavior, not
// a hand-rolled stand-in) augmented with stub FSA convenience methods to satisfy
// FileSystemWritableFileStream's type — pipeTo never calls write()/seek()/truncate() itself (it uses
// the stream's own writer protocol via `sink`), so these three are never actually invoked here.
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
	startZipDownloadMock.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("narrowToAnyFile", () => {
	it("returns the file's data (structurally an AnyFile) for a file item", () => {
		const item = fileItem({ name: "a.txt", size: 10n })

		const file = narrowToAnyFile(item)

		expect(file.uuid).toBe(item.data.uuid)
		expect(file.size).toBe(10n)
	})

	it("throws for a directory item", () => {
		expect(() => narrowToAnyFile(dirItem())).toThrow()
	})
})

// ---------------------------------------------------------------------------
// runDownload — injected deps, no worker/query client; saveDownload/isPickerCancelled mocked at
// the module boundary (see the mock declarations above).
// ---------------------------------------------------------------------------

describe("runDownload (injected deps, save-download mocked)", () => {
	function makeHarness() {
		const download =
			vi.fn<(file: AnyFile, transferId: string, save: SaveTarget, onProgress: (bytes: bigint) => void) => Promise<void>>()
		const add = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const setProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const deps: RunDownloadDeps = { download, store: { add, setProgress, settle, remove } }

		return { deps, download, add, setProgress, settle, remove }
	}

	it("adds a downloading transfer (parentUuid null, size narrowed to a number) before calling download", async () => {
		const h = makeHarness()
		h.download.mockResolvedValue(undefined)

		await runDownload(h.deps, { item: fileItem({ name: "report.pdf", size: 2_048n }) })

		expect(h.add).toHaveBeenCalledTimes(1)
		expect(h.add.mock.calls[0]?.[0]).toMatchObject({
			direction: "download",
			name: "report.pdf",
			size: 2_048,
			bytesTransferred: 0,
			status: "downloading",
			parentUuid: null
		})
		expect(h.download).toHaveBeenCalledTimes(1)
	})

	it("resolves the save target using the item's decrypted name", async () => {
		const h = makeHarness()
		h.download.mockResolvedValue(undefined)

		await runDownload(h.deps, { item: fileItem({ name: "photo.png" }) })

		expect(saveDownloadMock).toHaveBeenCalledWith("photo.png")
	})

	it("settles done on success", async () => {
		const h = makeHarness()
		h.download.mockResolvedValue(undefined)

		const outcome = await runDownload(h.deps, { item: fileItem() })

		expect(outcome).toEqual({ status: "success" })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "done")
	})

	it("reports the first progress notification through to store.setProgress, narrowed to a number", async () => {
		const h = makeHarness()
		h.download.mockImplementation((_file, _id, _save, onProgress) => {
			onProgress(512n)

			return Promise.resolve()
		})

		await runDownload(h.deps, { item: fileItem() })

		expect(h.setProgress).toHaveBeenCalledWith(expect.any(String), 512)
	})

	it("returns an error outcome and settles error on a non-cancel rejection", async () => {
		const h = makeHarness()
		const dto = sdkDto("Timeout")
		h.download.mockRejectedValue(dto)

		const outcome = await runDownload(h.deps, { item: fileItem() })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "error", dto)
	})

	it("settles cancelled then removes the row on a Cancelled rejection, returning a clean success", async () => {
		const h = makeHarness()
		h.download.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await runDownload(h.deps, { item: fileItem() })

		expect(outcome).toEqual({ status: "success" })
		const id = h.settle.mock.calls[0]?.[0]
		expect(h.settle).toHaveBeenCalledWith(id, "cancelled")
		expect(h.remove).toHaveBeenCalledWith(id)
	})

	it("is a clean no-op (no store writes, no download call) when the user cancels the save picker", async () => {
		const h = makeHarness()
		saveDownloadMock.mockRejectedValue(new Error("aborted"))
		isPickerCancelledMock.mockReturnValue(true)

		const outcome = await runDownload(h.deps, { item: fileItem() })

		expect(outcome).toEqual({ status: "success" })
		expect(h.add).not.toHaveBeenCalled()
		expect(h.download).not.toHaveBeenCalled()
	})

	it("returns an error outcome (not a no-op) when saveDownload rejects for a real reason", async () => {
		const h = makeHarness()
		saveDownloadMock.mockRejectedValue(new Error("disk full"))
		isPickerCancelledMock.mockReturnValue(false)

		const outcome = await runDownload(h.deps, { item: fileItem() })

		expect(outcome.status).toBe("error")
		expect(h.add).not.toHaveBeenCalled()
	})

	it("returns an error outcome for a directory item without prompting a save dialog or touching the store", async () => {
		const h = makeHarness()

		const outcome = await runDownload(h.deps, { item: dirItem() })

		expect(outcome.status).toBe("error")
		expect(saveDownloadMock).not.toHaveBeenCalled()
		expect(h.add).not.toHaveBeenCalled()
		expect(h.download).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// defaultDownloadDeps.download — the real Comlink.transfer/Comlink.proxy + coordinated-teardown
// wiring, exercised against real WHATWG streams with only sdkApi.downloadFileToWriter mocked.
// ---------------------------------------------------------------------------

describe("defaultDownloadDeps.download — fsa branch", () => {
	it("pipes bytes written to the transferred writer through to the fsa sink, and forwards progress", async () => {
		const written: Uint8Array[] = []
		const sinkAbort = vi.fn()
		const save: FsaSaveTarget = {
			kind: "fsa",
			writable: fsaWritable({ write: chunk => void written.push(chunk), abort: sinkAbort })
		}

		downloadFileToWriter.mockImplementation(
			async (_file: AnyFile, _id: string, writer: WritableStream<Uint8Array>, onProgress: (bytes: bigint) => void) => {
				const w = writer.getWriter()
				await w.write(new Uint8Array([1, 2, 3]))
				onProgress(3n)
				await w.close()
			}
		)

		const onProgress = vi.fn()

		await defaultDownloadDeps.download(testFile(), "transfer-id", save, onProgress)

		expect(written).toEqual([new Uint8Array([1, 2, 3])])
		expect(onProgress).toHaveBeenCalledWith(3n)
		expect(sinkAbort).not.toHaveBeenCalled()
	})

	it("passes a directly-callable progress function through the Comlink.proxy wrap", async () => {
		downloadFileToWriter.mockImplementation(
			async (_file: AnyFile, _id: string, writer: WritableStream<Uint8Array>, onProgress: (bytes: bigint) => void) => {
				onProgress(999n)
				await writer.getWriter().close()
			}
		)
		const save: FsaSaveTarget = { kind: "fsa", writable: fsaWritable() }
		const onProgress = vi.fn()

		await defaultDownloadDeps.download(testFile(), "transfer-id", save, onProgress)

		expect(onProgress).toHaveBeenCalledWith(999n)
	})

	it("tears down (aborts) the fsa sink when the worker call rejects — coordinated teardown", async () => {
		const sinkAbort = vi.fn()
		const save: FsaSaveTarget = { kind: "fsa", writable: fsaWritable({ abort: sinkAbort }) }
		const dto = sdkDto("Cancelled")

		// Mirrors the SDK's own leave-writable-open-on-abort behavior: the worker call rejects without
		// ever closing the transferred writer.
		downloadFileToWriter.mockRejectedValue(dto)

		await expect(defaultDownloadDeps.download(testFile(), "transfer-id", save, vi.fn())).rejects.toEqual(dto)

		expect(sinkAbort).toHaveBeenCalledTimes(1)
	})
})

describe("defaultDownloadDeps.download — sw branch", () => {
	it("delegates to triggerSwDownload for a sw target, never touching the worker op", async () => {
		triggerSwDownloadMock.mockResolvedValue(undefined)
		const save: SwSaveTarget = { kind: "sw", id: "id-1", url: "/sw/download/id-1", name: "a.txt" }
		const file = testFile()

		await defaultDownloadDeps.download(file, "transfer-id", save, vi.fn())

		expect(triggerSwDownloadMock).toHaveBeenCalledWith(file, save)
		expect(downloadFileToWriter).not.toHaveBeenCalled()
	})
})

describe("defaultDownloadDeps.cancel", () => {
	it("fires sdkApi.cancelDownload for the given transferId", () => {
		defaultDownloadDeps.cancel?.("transfer-id")

		expect(cancelDownload).toHaveBeenCalledWith("transfer-id")
	})
})

// ---------------------------------------------------------------------------
// startDownloads / startZipDownload — real runDownload + defaultDownloadDeps wiring.
// ---------------------------------------------------------------------------

describe("startDownloads (real runDownload + defaultDownloadDeps)", () => {
	it("is a no-op for an empty selection", async () => {
		await startDownloads([])

		expect(saveDownloadMock).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("downloads a single file directly without a misleading success toast (the transfers row is the signal)", async () => {
		downloadFileToWriter.mockImplementation(async (_file: AnyFile, _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startDownloads([fileItem({ name: "a.txt" })])

		expect(saveDownloadMock).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	// runDownload can't distinguish a picker-cancel from a real download (both resolve
	// {status:"success"}) — proves the fix never fires the misleading toast either way.
	it("produces no success toast when the user cancels the save picker (a clean no-op, not a download)", async () => {
		saveDownloadMock.mockRejectedValue(new Error("aborted"))
		isPickerCancelledMock.mockReturnValue(true)

		await startDownloads([fileItem()])

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("toasts a failure summary when the single download errors", async () => {
		downloadFileToWriter.mockRejectedValue(sdkDto("Timeout"))

		await startDownloads([fileItem()])

		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("routes a single directory to the zip seam instead of downloading directly", async () => {
		await startDownloads([dirItem()])

		expect(saveDownloadMock).not.toHaveBeenCalled()
		expect(startZipDownloadMock).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("routes a multi-file selection (no directory) to the zip seam, never N single downloads", async () => {
		const items = [fileItem({ name: "a.txt" }), fileItem({ name: "b.txt" })]

		await startDownloads(items)

		expect(saveDownloadMock).not.toHaveBeenCalled()
		expect(startZipDownloadMock).toHaveBeenCalledWith(items)
	})

	it("registers one done transfer in the real transfers store for a single successful download", async () => {
		downloadFileToWriter.mockImplementation(async (_file: AnyFile, _id: string, writer: WritableStream<Uint8Array>) => {
			await writer.getWriter().close()
		})

		await startDownloads([fileItem()])

		const transfers = useTransfersStore.getState().transfers
		expect(transfers).toHaveLength(1)
		expect(transfers[0]).toMatchObject({ direction: "download", status: "done" })
	})
})

// The exported single-unifying-gate predicate every download entry point (item-menu/bulk-bar/keymap)
// enables on — proven directly here so those call sites can trust it without re-deriving the rule.
describe("needsZip (the zip-gate predicate)", () => {
	it("is false for a single file", () => {
		expect(needsZip([fileItem()])).toBe(false)
	})

	it("is true for a single directory", () => {
		expect(needsZip([dirItem()])).toBe(true)
	})

	it("is true for more than one item, even all files", () => {
		expect(needsZip([fileItem(), fileItem()])).toBe(true)
	})

	it("is false for an empty selection", () => {
		expect(needsZip([])).toBe(false)
	})
})
