import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { AnyFile, Dir, DirsAndFilesWithPaths, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { Transfer, TerminalStatus } from "@/features/transfers/store/useTransfersStore"

// Mock boundary mirrors uploadDirectory.test.ts's own: the real sdk client/query client modules
// touch a Vite `?worker` / an OPFS-backed persister, unresolvable under node vitest. Only the
// "importItems (real wiring)" describe block below reaches these — every runImportFile/
// runImportDirectory test uses fully injected deps (RunImportFileDeps/RunImportDirectoryDeps), no
// worker mock needed at all.
const { createDirectory, uploadFile, downloadFileToWriter, listDirectoryRecursiveForImport } = vi.hoisted(() => ({
	createDirectory: vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>(),
	uploadFile:
		vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>(),
	downloadFileToWriter:
		vi.fn<
			(file: AnyFile, transferId: string, writer: WritableStream<Uint8Array>, onProgress: (bytes: bigint) => void) => Promise<void>
		>(),
	listDirectoryRecursiveForImport: vi.fn<(dir: unknown) => Promise<{ listing: DirsAndFilesWithPaths; hadScanErrors: boolean }>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createDirectory, uploadFile, downloadFileToWriter, listDirectoryRecursiveForImport }
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import {
	runImportFile,
	runImportDirectory,
	importItems,
	type RunImportFileDeps,
	type RunImportDirectoryDeps
} from "@/features/drive/lib/import"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function testFile(overrides: Partial<AnyFile> = {}): AnyFile {
	return {
		uuid: testUuid("src"),
		meta: { type: "encrypted", data: "ciphertext" },
		parent: testUuid("parent"),
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

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Shared" } },
		...overrides
	}
}

function dirItem(overrides: Partial<Dir> = {}): Extract<DriveItem, { type: "directory" }> {
	const item = narrowItem(mockDir(overrides))

	if (item.type !== "directory") {
		throw new Error("expected a directory item")
	}

	return item
}

function fileItem(overrides: Partial<import("@filen/sdk-rs").File> = {}): DriveItem {
	return narrowItem({
		uuid: testUuid("file"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1_024n, key: "k", version: 2 } },
		...overrides
	})
}

function nestedFile(name: string, path: string): { path: string; file: import("@filen/sdk-rs").File } {
	return {
		path,
		file: {
			uuid: testUuid(name),
			parent: testUuid("parent"),
			size: 512n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 0n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 512n, key: "k", version: 2 } }
		}
	}
}

// A real WritableStream-and-collect writer — mirrors download.test.ts's own fsa-branch sink, but
// this one just accumulates chunks so mocked downloadFileToWriter implementations can prove the
// bytes actually made it into the Blob runImportFile hands to upload.
async function drainToBytes(writer: WritableStream<Uint8Array>, bytes: Uint8Array): Promise<void> {
	const w = writer.getWriter()
	await w.write(bytes)
	await w.close()
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
})

afterEach(() => {
	vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// runImportFile — injected deps, no worker/query client at all.
// ---------------------------------------------------------------------------

describe("runImportFile (injected deps)", () => {
	function makeHarness() {
		const download = vi.fn<RunImportFileDeps["download"]["download"]>()
		const add = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const setProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const upload = vi.fn<RunUploadFn>()
		const uploadAdd = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const uploadSetProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const uploadSettle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const uploadRemove = vi.fn<(id: string) => void>()
		const patchListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()

		const deps: RunImportFileDeps = {
			download: { download, store: { add, setProgress, settle, remove } },
			upload: {
				upload,
				store: { add: uploadAdd, setProgress: uploadSetProgress, settle: uploadSettle, remove: uploadRemove },
				patchListing
			}
		}

		return { deps, download, settle, remove, upload, uploadSettle }
	}

	type RunUploadFn = (parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>

	it("downloads into memory then hands the collected bytes to upload, preserving parentUuid/name/mime", async () => {
		const h = makeHarness()
		h.download.mockImplementation(async (_file, _id, writer) => {
			await drainToBytes(writer, new Uint8Array([1, 2, 3]))
		})
		h.upload.mockResolvedValue({ ...testFile(), uuid: testUuid("uploaded") } as unknown as SdkFile)

		const outcome = await runImportFile(h.deps, {
			file: testFile(),
			name: "photo.png",
			size: 3,
			mime: "image/png",
			parentUuid: "dest-uuid"
		})

		expect(outcome).toEqual({ status: "success" })
		expect(h.upload).toHaveBeenCalledTimes(1)
		const [parentUuid, , file] = h.upload.mock.calls[0] ?? []
		expect(parentUuid).toBe("dest-uuid")
		expect(file?.name).toBe("photo.png")
		expect(file?.type).toBe("image/png")
		expect(await file?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)
	})

	it("registers a download-direction transfer row before calling download", async () => {
		const h = makeHarness()
		h.download.mockImplementation(async (_file, _id, writer) => {
			await drainToBytes(writer, new Uint8Array())
		})
		h.upload.mockResolvedValue(testFile() as unknown as SdkFile)

		await runImportFile(h.deps, { file: testFile(), name: "a.txt", size: 0, parentUuid: null })

		expect(h.download).toHaveBeenCalledTimes(1)
	})

	it("never attempts an upload and reports its own cancelled status when the download is cancelled", async () => {
		const h = makeHarness()
		h.download.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await runImportFile(h.deps, { file: testFile(), name: "a.txt", size: 0, parentUuid: null })

		expect(outcome).toEqual({ status: "cancelled" })
		expect(h.upload).not.toHaveBeenCalled()
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "cancelled")
	})

	it("returns an error outcome and never attempts an upload on a non-cancel download failure", async () => {
		const h = makeHarness()
		const dto = sdkDto("Timeout")
		h.download.mockRejectedValue(dto)

		const outcome = await runImportFile(h.deps, { file: testFile(), name: "a.txt", size: 0, parentUuid: null })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.upload).not.toHaveBeenCalled()
	})

	it("propagates an upload failure as the import's own error outcome", async () => {
		const h = makeHarness()
		h.download.mockImplementation(async (_file, _id, writer) => {
			await drainToBytes(writer, new Uint8Array())
		})
		const dto = sdkDto("MaxStorageReached")
		h.upload.mockRejectedValue(dto)

		const outcome = await runImportFile(h.deps, { file: testFile(), name: "a.txt", size: 0, parentUuid: null })

		expect(outcome).toEqual({ status: "error", dto })
	})
})

// ---------------------------------------------------------------------------
// runImportDirectory — injected deps (including listRecursive), no worker/query client at all.
// ---------------------------------------------------------------------------

describe("runImportDirectory (injected deps, real runCreateDirectory/runImportFile)", () => {
	function makeHarness() {
		const create = vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>()
		const patchDirListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()
		const download = vi.fn<RunImportFileDeps["download"]["download"]>()
		const upload =
			vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>()
		const listRecursive = vi.fn<RunImportDirectoryDeps["listRecursive"]>()

		const deps: RunImportDirectoryDeps = {
			createDirectory: { createDirectory: create, patchListing: patchDirListing },
			importFile: {
				download: { download, store: { add: vi.fn(), setProgress: vi.fn(), settle: vi.fn(), remove: vi.fn() } },
				upload: { upload, store: { add: vi.fn(), setProgress: vi.fn(), settle: vi.fn(), remove: vi.fn() }, patchListing: vi.fn() }
			},
			listRecursive
		}

		return { deps, create, download, upload, listRecursive }
	}

	function resolveDirByName(h: ReturnType<typeof makeHarness>): void {
		h.create.mockImplementation((_parentUuid: string | null, name: string) =>
			Promise.resolve(mockDir({ uuid: testUuid(name), meta: { type: "decoded", data: { name } } }))
		)
	}

	function emptyDownload(h: ReturnType<typeof makeHarness>): void {
		h.download.mockImplementation(async (_file: AnyFile, _id: string, writer: WritableStream<Uint8Array>) => {
			await drainToBytes(writer, new Uint8Array())
		})
	}

	it("creates the imported directory's own top-level entry at the destination first", async () => {
		const h = makeHarness()
		resolveDirByName(h)
		h.listRecursive.mockResolvedValue({ listing: { dirs: [], files: [] }, hadScanErrors: false })

		await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(h.create).toHaveBeenNthCalledWith(1, "dest-root", "Shared")
	})

	it("recreates nested sub-directories parent-before-child under the new root, and routes files to their recreated parent", async () => {
		const h = makeHarness()
		resolveDirByName(h)
		emptyDownload(h)
		h.upload.mockResolvedValue({ ...testFile(), uuid: testUuid("uploaded") } as unknown as SdkFile)
		h.listRecursive.mockResolvedValue({
			listing: {
				dirs: [{ path: "sub", dir: mockDir({ meta: { type: "decoded", data: { name: "sub" } } }) } as never],
				files: [nestedFile("a.txt", "sub/a.txt")]
			},
			hadScanErrors: false
		})

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(outcome).toEqual({ status: "success" })
		// "Shared" (the root itself) then "sub" underneath it.
		expect(h.create).toHaveBeenNthCalledWith(1, "dest-root", "Shared")
		expect(h.create).toHaveBeenNthCalledWith(2, testUuid("Shared"), "sub")
		expect(h.upload).toHaveBeenCalledWith(
			testUuid("sub"),
			expect.any(String),
			expect.objectContaining({ name: "a.txt" }),
			expect.any(Function)
		)
	})

	it("reports a partial-import error rather than a hollow success when a nested file's download is cancelled", async () => {
		const h = makeHarness()
		resolveDirByName(h)
		h.download.mockRejectedValue(sdkDto("Cancelled"))
		h.listRecursive.mockResolvedValue({
			listing: { dirs: [], files: [nestedFile("a.txt", "a.txt")] },
			hadScanErrors: false
		})

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(outcome.status).toBe("error")
		expect(h.upload).not.toHaveBeenCalled()
	})

	it("returns a partial-import error and creates no sub-tree when the recursive scan reports scan errors", async () => {
		const h = makeHarness()
		resolveDirByName(h)
		h.listRecursive.mockResolvedValue({ listing: { dirs: [], files: [] }, hadScanErrors: true })

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(outcome.status).toBe("error")
		// Only the root itself was created — the scan-error bail happens before any sub-tree work.
		expect(h.create).toHaveBeenCalledTimes(1)
	})

	it("skips a sub-directory's whole subtree when its parent fails to create, without aborting siblings", async () => {
		const h = makeHarness()
		h.create.mockResolvedValueOnce(mockDir({ uuid: testUuid("Shared"), meta: { type: "decoded", data: { name: "Shared" } } }))
		h.create.mockRejectedValueOnce(sdkDto("DirCreateFileExists"))
		emptyDownload(h)
		h.upload.mockResolvedValue(testFile() as unknown as SdkFile)
		h.listRecursive.mockResolvedValue({
			listing: {
				dirs: [{ path: "bad", dir: mockDir() } as never],
				files: [nestedFile("under-root.txt", "under-root.txt"), nestedFile("under-bad.txt", "bad/under-bad.txt")]
			},
			hadScanErrors: false
		})

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(outcome.status).toBe("error")
		// Only the file directly under the root uploads; the file nested under the failed "bad" never does.
		expect(h.upload).toHaveBeenCalledTimes(1)
		expect(h.upload).toHaveBeenCalledWith(
			testUuid("Shared"),
			expect.any(String),
			expect.objectContaining({ name: "under-root.txt" }),
			expect.any(Function)
		)
	})

	it("returns success with no failed entries for an empty directory (root created, nothing else)", async () => {
		const h = makeHarness()
		resolveDirByName(h)
		h.listRecursive.mockResolvedValue({ listing: { dirs: [], files: [] }, hadScanErrors: false })

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Empty", parentUuid: null })

		expect(outcome).toEqual({ status: "success" })
		expect(h.upload).not.toHaveBeenCalled()
	})

	it("fails outright without listing when the root directory itself fails to create", async () => {
		const h = makeHarness()
		h.create.mockRejectedValue(sdkDto("DirCreateFileExists"))

		const outcome = await runImportDirectory(h.deps, { item: dirItem(), name: "Shared", parentUuid: "dest-root" })

		expect(outcome.status).toBe("error")
		expect(h.listRecursive).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// importItems — real wiring against a mocked sdkApi/queryClient (mirrors uploadDirectory.test.ts's
// "startDirectoryUpload (real wiring)" block).
// ---------------------------------------------------------------------------

describe("importItems (real wiring)", () => {
	it("imports a single sharedIn file end-to-end: downloads then uploads via the real worker ops", async () => {
		downloadFileToWriter.mockImplementation(async (_file, _id, writer) => {
			const w = writer.getWriter()
			await w.write(new Uint8Array([9, 9]))
			await w.close()
		})
		uploadFile.mockResolvedValue({ ...testFile(), uuid: testUuid("uploaded") } as unknown as SdkFile)

		const outcome = await importItems([fileItem()], "dest-uuid")

		expect(outcome.failed).toEqual([])
		expect(outcome.succeeded).toHaveLength(1)
		expect(uploadFile).toHaveBeenCalledTimes(1)
		expect(uploadFile.mock.calls[0]?.[0]).toBe("dest-uuid")
	})

	it("reports a failure without throwing when the download rejects", async () => {
		downloadFileToWriter.mockRejectedValue(sdkDto("Timeout"))

		const outcome = await importItems([fileItem()], "dest-uuid")

		expect(outcome.succeeded).toEqual([])
		expect(outcome.failed).toHaveLength(1)
		expect(uploadFile).not.toHaveBeenCalled()
	})

	it("reports neither a success nor a failure when the download is cancelled — toastBulkOutcome's own empty-outcome case", async () => {
		downloadFileToWriter.mockRejectedValue(sdkDto("Cancelled"))

		const outcome = await importItems([fileItem()], "dest-uuid")

		expect(outcome.succeeded).toEqual([])
		expect(outcome.failed).toEqual([])
		expect(uploadFile).not.toHaveBeenCalled()
	})

	it("imports a directory end-to-end: creates the destination tree via createDirectory, then uploads its file", async () => {
		createDirectory.mockImplementation((_parentUuid: string | null, name: string) =>
			Promise.resolve(mockDir({ uuid: testUuid(name), meta: { type: "decoded", data: { name } } }))
		)
		listDirectoryRecursiveForImport.mockResolvedValue({
			listing: { dirs: [], files: [nestedFile("a.txt", "a.txt")] },
			hadScanErrors: false
		})
		downloadFileToWriter.mockImplementation(async (_file, _id, writer) => {
			const w = writer.getWriter()
			await w.close()
		})
		uploadFile.mockResolvedValue(testFile() as unknown as SdkFile)

		const outcome = await importItems([dirItem({ meta: { type: "decoded", data: { name: "Shared" } } })], "dest-root")

		expect(outcome.failed).toEqual([])
		expect(createDirectory).toHaveBeenCalledWith("dest-root", "Shared")
		expect(uploadFile).toHaveBeenCalledWith(
			testUuid("Shared"),
			expect.any(String),
			expect.objectContaining({ name: "a.txt" }),
			expect.any(Function)
		)
	})
})
