import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { Transfer, TerminalStatus } from "@/features/transfers/store/useTransfersStore"

// Same mock boundary as upload.test.ts/createDirectory.test.ts/drive.test.ts: the real sdk
// client/query client modules touch a Vite `?worker` / an OPFS-backed persister, unresolvable under
// node vitest. Mocking `@/lib/sdk/client` and `@/queries/client` (not `@/queries/drive`,
// `@/features/drive/lib/upload`, or `@/features/drive/lib/createDirectory`) lets startDirectoryUpload's
// real defaultDirectoryUploadDeps wiring — driveListingQueryUpdate, runCreateDirectory, runUpload,
// defaultUploadDeps — run for real against those two mocked leaves.
const { createDirectory, uploadFile } = vi.hoisted(() => ({
	createDirectory: vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>(),
	uploadFile:
		vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { createDirectory, uploadFile } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

// toastLoading returns a fixed id — startDirectoryUpload's own scanning-toast id — so assertions
// below can check it's the exact id later reused to dismiss/replace it, same as the real sonner
// contract (toast.loading returns the id you pass back into toast.dismiss/toast.error's own options).
const { toastSuccess, toastError, toastLoading, toastDismiss } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastLoading: vi.fn(() => "scan-toast-id"),
	toastDismiss: vi.fn()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, loading: toastLoading, dismiss: toastDismiss } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import {
	collectDirectoryUploads,
	runDirectoryUpload,
	startDirectoryUpload,
	type RunDirectoryUploadDeps
} from "@/features/drive/lib/uploadDirectory"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring upload.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockSdkFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("uploaded"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "file.txt", mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function mockBrowserFile(name: string, size = 64): File {
	return new File([new Uint8Array(size)], name)
}

// A `webkitdirectory`-picked File — `webkitRelativePath` is readonly on the real DOM type, so it can
// only be stamped on after construction. `name` is derived from the relPath's own final segment,
// mirroring what a real picker hands back (a File's `.name` is always its own leaf name).
function mockRelFile(relPath: string, size = 64): File {
	const segments = relPath.split("/")
	const name = segments.at(-1) ?? relPath
	const file = mockBrowserFile(name, size)

	Object.defineProperty(file, "webkitRelativePath", { value: relPath })

	return file
}

// Structurally required by FileSystemEntry/FileSystemDirectoryEntry/FileSystemFileEntry but never
// read by uploadDirectory.ts's own walk (only name/isFile/isDirectory/createReader/file matter) —
// a permissive Record avoids constructing FileSystem's genuinely circular `root` shape for fields the
// code under test can't observe either way; each factory below casts once, at its own boundary.
function baseEntry(name: string, isDirectory: boolean): Record<string, unknown> {
	return {
		name,
		isDirectory,
		isFile: !isDirectory,
		fullPath: `/${name}`,
		filesystem: { name: "mock-fs", root: null },
		getParent: () => undefined
	}
}

function mockFileEntry(name: string, file: File): FileSystemFileEntry {
	return {
		...baseEntry(name, false),
		file: (successCallback: (file: File) => void) => {
			successCallback(file)
		}
	} as FileSystemFileEntry
}

// Delivers `entries` on the first readEntries call and an empty batch on every call after —
// satisfies the paginated "call until empty" contract for a directory small enough to read in one
// batch (the common case every non-pagination-focused test below uses).
function mockDirectoryReader(entries: FileSystemEntry[]): FileSystemDirectoryReader {
	let delivered = false

	return {
		readEntries: successCallback => {
			if (delivered) {
				successCallback([])
				return
			}

			delivered = true
			successCallback(entries)
		}
	}
}

// One batch per call, empty once `batches` is exhausted — used by the pagination-specific test to
// prove readAllEntries keeps calling readEntries rather than trusting a single batch.
function mockPaginatedReader(batches: FileSystemEntry[][]): FileSystemDirectoryReader {
	let index = 0

	return {
		readEntries: successCallback => {
			const batch = batches[index] ?? []
			index += 1
			successCallback(batch)
		}
	}
}

// A reader whose read fails outright — the DnD-walk analogue of a permission error enumerating a
// real directory; exercises startDirectoryUpload's own catch path around collectDirectoryUploads.
function mockFailingReader(): FileSystemDirectoryReader {
	return {
		readEntries: (_successCallback, errorCallback) => {
			errorCallback?.(new DOMException("denied", "NotReadableError"))
		}
	}
}

function mockDirEntry(name: string, reader: FileSystemDirectoryReader): FileSystemDirectoryEntry {
	return {
		...baseEntry(name, true),
		createReader: () => reader
	} as FileSystemDirectoryEntry
}

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
	useTransfersStore.setState({ transfers: [] })
})

// ---------------------------------------------------------------------------
// collectDirectoryUploads
// ---------------------------------------------------------------------------

describe("collectDirectoryUploads — webkitdirectory FileList input", () => {
	it("derives each file's relPath and the unique ancestor dir set from webkitRelativePath", async () => {
		const files = [mockRelFile("myfolder/a.txt"), mockRelFile("myfolder/sub/b.txt"), mockRelFile("myfolder/sub/c.txt")]

		const result = await collectDirectoryUploads({ kind: "files", files })

		expect(new Set(result.dirs)).toEqual(new Set(["myfolder", "myfolder/sub"]))
		expect(result.files).toHaveLength(3)
		expect(result.files.map(f => f.relPath).sort()).toEqual(["myfolder/a.txt", "myfolder/sub/b.txt", "myfolder/sub/c.txt"])
	})

	it("includes every ancestor level, not just the immediate parent", async () => {
		const files = [mockRelFile("a/b/c/d.txt")]

		const result = await collectDirectoryUploads({ kind: "files", files })

		expect(new Set(result.dirs)).toEqual(new Set(["a", "a/b", "a/b/c"]))
	})

	it("produces no dirs for a flat set of top-level files", async () => {
		const files = [mockRelFile("a.txt"), mockRelFile("b.txt")]

		const result = await collectDirectoryUploads({ kind: "files", files })

		expect(result.dirs).toEqual([])
		expect(result.files.map(f => f.relPath)).toEqual(["a.txt", "b.txt"])
	})

	it("preserves the original File reference for each entry", async () => {
		const file = mockRelFile("myfolder/a.txt")

		const result = await collectDirectoryUploads({ kind: "files", files: [file] })

		expect(result.files[0]?.file).toBe(file)
	})
})

describe("collectDirectoryUploads — drag-and-drop FileSystemEntry input", () => {
	it("walks a nested directory tree, collecting files with their relPath and every directory including empty ones", async () => {
		const fileA = mockBrowserFile("a.txt")
		const fileB = mockBrowserFile("b.txt")
		const sub = mockDirEntry("sub", mockDirectoryReader([mockFileEntry("b.txt", fileB)]))
		const emptySub = mockDirEntry("emptysub", mockDirectoryReader([]))
		const root = mockDirEntry("myfolder", mockDirectoryReader([mockFileEntry("a.txt", fileA), sub, emptySub]))

		const result = await collectDirectoryUploads({ kind: "entries", entries: [root] })

		expect(new Set(result.dirs)).toEqual(new Set(["myfolder", "myfolder/sub", "myfolder/emptysub"]))
		expect(result.files.map(f => ({ relPath: f.relPath, file: f.file })).sort((x, y) => x.relPath.localeCompare(y.relPath))).toEqual([
			{ relPath: "myfolder/a.txt", file: fileA },
			{ relPath: "myfolder/sub/b.txt", file: fileB }
		])
	})

	it("handles a mix of top-level files and directories in one drop", async () => {
		const looseFile = mockBrowserFile("loose.txt")
		const nestedFile = mockBrowserFile("nested.txt")
		const dir = mockDirEntry("myfolder", mockDirectoryReader([mockFileEntry("nested.txt", nestedFile)]))

		const result = await collectDirectoryUploads({ kind: "entries", entries: [mockFileEntry("loose.txt", looseFile), dir] })

		expect(result.dirs).toEqual(["myfolder"])
		expect(result.files.map(f => f.relPath).sort()).toEqual(["loose.txt", "myfolder/nested.txt"])
	})

	it("paginates createReader().readEntries() until it returns an empty batch", async () => {
		const fileA = mockBrowserFile("a.txt")
		const fileB = mockBrowserFile("b.txt")
		const reader = mockPaginatedReader([[mockFileEntry("a.txt", fileA)], [mockFileEntry("b.txt", fileB)]])
		const root = mockDirEntry("myfolder", reader)

		const result = await collectDirectoryUploads({ kind: "entries", entries: [root] })

		expect(result.files.map(f => f.relPath).sort()).toEqual(["myfolder/a.txt", "myfolder/b.txt"])
	})

	it("records a totally empty top-level directory as a dir with no files", async () => {
		const root = mockDirEntry("emptyfolder", mockDirectoryReader([]))

		const result = await collectDirectoryUploads({ kind: "entries", entries: [root] })

		expect(result.dirs).toEqual(["emptyfolder"])
		expect(result.files).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// runDirectoryUpload — injected deps (mirrors createDirectory.test.ts/upload.test.ts's own
// injected-deps harness style): the REAL runCreateDirectory/runUpload run against mocked leaf calls.
// ---------------------------------------------------------------------------

describe("runDirectoryUpload (injected deps, real runCreateDirectory/runUpload)", () => {
	function makeHarness() {
		const create = vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>()
		const patchDirListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()
		const upload =
			vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>()
		const add = vi.fn<(t: Omit<Transfer, "paused">) => void>()
		const setProgress = vi.fn<(id: string, bytesTransferred: number) => void>()
		const settle = vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>()
		const remove = vi.fn<(id: string) => void>()
		const patchFileListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()

		const deps: RunDirectoryUploadDeps = {
			createDirectory: { createDirectory: create, patchListing: patchDirListing },
			upload: { upload, store: { add, setProgress, settle, remove }, patchListing: patchFileListing }
		}

		return { deps, create, patchDirListing, upload, add, settle, patchFileListing }
	}

	// createDirectory resolves a distinct uuid per leaf name — lets assertions confirm each file/dir
	// was routed to the uuid ITS OWN parent actually received, not just call counts.
	function resolveByName(h: ReturnType<typeof makeHarness>): void {
		h.create.mockImplementation((_parentUuid, name) =>
			Promise.resolve(mockDir({ uuid: testUuid(name), meta: { type: "decoded", data: { name } } }))
		)
	}

	it("is a no-op — no calls, no toast — when both dirs and files are empty", async () => {
		const h = makeHarness()

		await runDirectoryUpload(h.deps, { rootParentUuid: null, dirs: [], files: [] })

		expect(h.create).not.toHaveBeenCalled()
		expect(h.upload).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("creates dirs parent-before-child and routes each file to its created parent's uuid", async () => {
		const h = makeHarness()
		resolveByName(h)
		h.upload.mockResolvedValue(mockSdkFile())

		await runDirectoryUpload(h.deps, {
			rootParentUuid: "root-uuid",
			dirs: ["a", "a/b"],
			files: [
				{ file: mockBrowserFile("x.txt"), relPath: "a/x.txt" },
				{ file: mockBrowserFile("y.txt"), relPath: "a/b/y.txt" }
			]
		})

		expect(h.create).toHaveBeenNthCalledWith(1, "root-uuid", "a")
		expect(h.create).toHaveBeenNthCalledWith(2, testUuid("a"), "b")
		// "a/x.txt"'s parent is "a" (created with basename "a", uuid testUuid("a")); "a/b/y.txt"'s
		// parent is "a/b" (created with basename "b", uuid testUuid("b")) — each file must land under
		// its OWN recreated parent, not just any created dir.
		expect(h.upload).toHaveBeenCalledWith(
			testUuid("a"),
			expect.any(String),
			expect.objectContaining({ name: "x.txt" }),
			expect.any(Function)
		)
		expect(h.upload).toHaveBeenCalledWith(
			testUuid("b"),
			expect.any(String),
			expect.objectContaining({ name: "y.txt" }),
			expect.any(Function)
		)
	})

	it("creates dirs in depth order even when the input array lists deeper paths first", async () => {
		const h = makeHarness()
		resolveByName(h)

		await runDirectoryUpload(h.deps, { rootParentUuid: null, dirs: ["a/b/c", "a", "a/b"], files: [] })

		expect(h.create.mock.calls.map(call => call[1])).toEqual(["a", "b", "c"])
	})

	it("skips a sub-directory's whole subtree — and every file under it — when its parent fails to create", async () => {
		const h = makeHarness()
		// Depth-ascending order processes exactly two dirs here: "a" (call 1) then "a/b" (call 2) —
		// "a/b/c" is never even attempted, since its parent "a/b" never resolves to a uuid.
		h.create.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), meta: { type: "decoded", data: { name: "a" } } }))
		h.create.mockRejectedValueOnce(sdkDto("DirCreateFileExists"))
		h.upload.mockResolvedValue(mockSdkFile())

		await runDirectoryUpload(h.deps, {
			rootParentUuid: "root-uuid",
			dirs: ["a", "a/b", "a/b/c"],
			files: [
				{ file: mockBrowserFile("under-a.txt"), relPath: "a/under-a.txt" },
				{ file: mockBrowserFile("under-b.txt"), relPath: "a/b/under-b.txt" },
				{ file: mockBrowserFile("under-c.txt"), relPath: "a/b/c/under-c.txt" }
			]
		})

		// "a" created, "b" attempted-and-failed, "c" never even attempted (its parent "a/b" never
		// resolved to a uuid).
		expect(h.create).toHaveBeenCalledTimes(2)
		expect(h.create.mock.calls.map(call => call[1])).toEqual(["a", "b"])

		// Only the file directly under the successfully-created "a" uploads; both files nested under
		// the failed "b" are skipped without ever calling upload.
		expect(h.upload).toHaveBeenCalledTimes(1)
		expect(h.upload).toHaveBeenCalledWith(
			testUuid("a"),
			expect.any(String),
			expect.objectContaining({ name: "under-a.txt" }),
			expect.any(Function)
		)

		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("records a failed file without blocking its sibling from uploading", async () => {
		const h = makeHarness()
		resolveByName(h)
		// The file fan-out (Promise.all(files.map(...))) invokes deps.upload synchronously in array
		// order before any of them settle, so "ok.txt" is call 1 and "bad.txt" is call 2 regardless of
		// which resolves/rejects first.
		h.upload.mockResolvedValueOnce(mockSdkFile())
		h.upload.mockRejectedValueOnce(sdkDto("UploadFailed"))

		await runDirectoryUpload(h.deps, {
			rootParentUuid: null,
			dirs: ["a"],
			files: [
				{ file: mockBrowserFile("ok.txt"), relPath: "a/ok.txt" },
				{ file: mockBrowserFile("bad.txt"), relPath: "a/bad.txt" }
			]
		})

		expect(h.upload).toHaveBeenCalledTimes(2)
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "done")
		expect(h.settle).toHaveBeenCalledWith(expect.any(String), "error", sdkDto("UploadFailed"))
		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("creates an empty sub-directory (no files anywhere under it) and still toasts success", async () => {
		const h = makeHarness()
		resolveByName(h)

		await runDirectoryUpload(h.deps, { rootParentUuid: null, dirs: ["a", "a/empty"], files: [] })

		expect(h.create).toHaveBeenCalledTimes(2)
		expect(h.upload).not.toHaveBeenCalled()
		expect(toastSuccess).toHaveBeenCalledWith(expect.any(String))
		expect(toastError).not.toHaveBeenCalled()
	})

	it("fans file uploads out in parallel, not one at a time", async () => {
		const h = makeHarness()
		resolveByName(h)
		const callOrder: string[] = []
		const resolvers: (() => void)[] = []

		h.upload.mockImplementation(async (_parentUuid, _transferId, file) => {
			callOrder.push(`called:${file.name}`)
			await new Promise<void>(resolve => {
				resolvers.push(resolve)
			})
			callOrder.push(`resolved:${file.name}`)
			return mockSdkFile()
		})

		const promise = runDirectoryUpload(h.deps, {
			rootParentUuid: null,
			dirs: [],
			files: [
				{ file: mockBrowserFile("a.txt"), relPath: "a.txt" },
				{ file: mockBrowserFile("b.txt"), relPath: "b.txt" }
			]
		})

		await Promise.resolve()
		await Promise.resolve()

		expect(callOrder).toEqual(["called:a.txt", "called:b.txt"])

		resolvers.forEach(resolve => {
			resolve()
		})
		await promise
	})
})

// ---------------------------------------------------------------------------
// startDirectoryUpload — real defaultDirectoryUploadDeps wiring against the mocked sdk client/query
// client/sonner declared at the top of this file (mirrors upload.test.ts's own startUploads block).
// ---------------------------------------------------------------------------

describe("startDirectoryUpload (real wiring)", () => {
	it("collects a picked directory and uploads it end-to-end, patching the drive listing and the transfers store", async () => {
		createDirectory.mockImplementation((_parentUuid, name) =>
			Promise.resolve(mockDir({ uuid: testUuid(name), meta: { type: "decoded", data: { name } } }))
		)
		uploadFile.mockImplementation((_parentUuid, _transferId, file) =>
			Promise.resolve(
				mockSdkFile({
					uuid: testUuid(file.name),
					meta: {
						type: "decoded",
						data: { name: file.name, mime: "text/plain", modified: 1_700_000_000_000n, size: 64n, key: "key", version: 2 }
					}
				})
			)
		)

		const files = [mockRelFile("myfolder/a.txt"), mockRelFile("myfolder/sub/b.txt")]

		await startDirectoryUpload({ kind: "files", files }, null)

		expect(createDirectory).toHaveBeenCalledTimes(2)
		expect(uploadFile).toHaveBeenCalledTimes(2)
		expect(toastSuccess).toHaveBeenCalledWith(expect.any(String))

		// The scanning toast shows for the tree-walk phase, then is dismissed (not left hanging)
		// once the walk resolves and the real per-item upload/summary toasts take over.
		expect(toastLoading).toHaveBeenCalledWith(expect.any(String))
		expect(toastDismiss).toHaveBeenCalledWith("scan-toast-id")

		const transfers = useTransfersStore.getState().transfers
		expect(transfers).toHaveLength(2)
		expect(transfers.every(transfer => transfer.status === "done")).toBe(true)

		// The top-level directory landed in the root listing's own cache — driveListingQueryUpdate
		// patches synchronously, no refetch needed (per createDirectory.ts/upload.ts's own contract).
		const rootListing = testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: null }))
		expect(rootListing?.some(item => item.data.uuid === testUuid("myfolder"))).toBe(true)
	})

	it("toasts a generic error and calls neither createDirectory nor uploadFile when the tree walk itself fails", async () => {
		const badDir = mockDirEntry("bad", mockFailingReader())

		await startDirectoryUpload({ kind: "entries", entries: [badDir] }, null)

		expect(createDirectory).not.toHaveBeenCalled()
		expect(uploadFile).not.toHaveBeenCalled()
		// The error toast replaces the scanning toast in place (same id) rather than popping a
		// second, separate toast, and the scanning toast is never separately dismissed on this path.
		expect(toastError).toHaveBeenCalledWith(expect.any(String), { id: "scan-toast-id" })
		expect(toastDismiss).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	// A scanning spinner/indicator at the fire-and-forget call sites (uploadMenu.tsx/
	// uploadDropzone.tsx both just `void startDirectoryUpload(...)`, with no transfer row yet to show
	// progress on): a loading toast fires the instant the walk starts, before the tree walk even
	// resolves.
	it("shows a scanning toast immediately", async () => {
		const badDir = mockDirEntry("bad", mockFailingReader())

		await startDirectoryUpload({ kind: "entries", entries: [badDir] }, null)

		expect(toastLoading).toHaveBeenCalledTimes(1)
		expect(toastLoading).toHaveBeenCalledWith(expect.any(String))
	})
})
