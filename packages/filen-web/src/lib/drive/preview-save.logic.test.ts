import { describe, expect, it, vi } from "vitest"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { isEditable, runPreviewSave, type PreviewSaveDeps } from "@/lib/drive/preview-save.logic"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import type { ErrorDTO } from "@/lib/sdk/errors"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring actions.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = testUuid("root")
const OTHER_PARENT_UUID = testUuid("other-parent")

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("file"),
		parent: OTHER_PARENT_UUID,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "notes.txt", mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function fileItem(overrides: Partial<SdkFile> = {}): DriveItem {
	const item = narrowItem(mockFile(overrides))
	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}
	return item
}

function dirItem(): DriveItem {
	const item = narrowItem({
		uuid: testUuid("dir"),
		parent: ROOT_UUID,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } }
	})
	if (item.type !== "directory") {
		throw new Error("expected a directory arm")
	}
	return item
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

// Full DecryptedFileMeta shape for a given name — mockFile's own default already carries one for
// "notes.txt"; this covers every other per-test extension the category resolver needs to see.
function decodedMeta(name: string): SdkFile["meta"] {
	return { type: "decoded", data: { name, mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
}

describe("isEditable", () => {
	it("is true for a decryptable text file in the drive variant", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("notes.txt") }), "drive")).toBe(true)
	})

	it("is true for a decryptable code file in the drive variant", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("index.ts") }), "drive")).toBe(true)
	})

	it("is false outside the drive variant (e.g. trash)", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("notes.txt") }), "trash")).toBe(false)
	})

	it("is false for a non-text/code category (e.g. an image)", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("photo.png") }), "drive")).toBe(false)
	})

	it("is false for markdown (its own view-source toggle stays read-only)", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("readme.md") }), "drive")).toBe(false)
	})

	it("is false for an undecryptable file", () => {
		expect(isEditable(fileItem({ meta: { type: "encrypted", data: "cipher" } }), "drive")).toBe(false)
	})

	it("is false for a directory", () => {
		expect(isEditable(dirItem(), "drive")).toBe(false)
	})
})

// All collaborators injected — no module mocks, mirroring create-directory.test.ts.
function makeHarness() {
	const uploadFileBytes = vi.fn<(parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>>()
	const patchListing = vi.fn<(parentUuid: string | null, updater: (items: DriveItem[]) => DriveItem[]) => void>()
	const deps: PreviewSaveDeps = { uploadFileBytes, patchListing, rootUuid: ROOT_UUID }
	return { deps, uploadFileBytes, patchListing }
}

describe("runPreviewSave (injected deps, no worker or query client)", () => {
	it("encodes the content, uploads it, and returns the narrowed new item on success", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))
		const item = fileItem({ uuid: testUuid("old"), parent: OTHER_PARENT_UUID })

		const outcome = await runPreviewSave(h.deps, { item, content: "hello world" })

		expect(outcome.status).toBe("success")
		if (outcome.status !== "success") {
			throw new Error("expected success")
		}
		expect(outcome.item.data.uuid).toBe(testUuid("new"))
		expect(h.uploadFileBytes).toHaveBeenCalledTimes(1)
		const [parentArg, dataArg, nameArg, mimeArg] = h.uploadFileBytes.mock.calls[0] ?? []
		expect(parentArg).toBe(OTHER_PARENT_UUID)
		expect(nameArg).toBe("notes.txt")
		expect(mimeArg).toBe("text/plain")
		expect(new TextDecoder().decode(dataArg)).toBe("hello world")
	})

	it("collapses the root uuid to null before uploading and patching", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new"), parent: ROOT_UUID }))
		const item = fileItem({ uuid: testUuid("old"), parent: ROOT_UUID })

		await runPreviewSave(h.deps, { item, content: "x" })

		expect(h.uploadFileBytes).toHaveBeenCalledWith(null, expect.any(Uint8Array), "notes.txt", "text/plain")
		expect(h.patchListing).toHaveBeenCalledWith(null, expect.any(Function))
	})

	it("patches the item's own (non-root) parent listing, dropping the old uuid, upserting the new one", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new"), parent: OTHER_PARENT_UUID }))
		const item = fileItem({ uuid: testUuid("old"), parent: OTHER_PARENT_UUID })

		await runPreviewSave(h.deps, { item, content: "x" })

		expect(h.patchListing).toHaveBeenCalledTimes(1)
		expect(h.patchListing).toHaveBeenCalledWith(OTHER_PARENT_UUID, expect.any(Function))
		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([item])
		expect(patched.map(i => i.data.uuid)).toEqual([testUuid("new")])
	})

	it("drops the old uuid even when the stale row is undecryptable (no name for the intrinsic dedup to match on)", async () => {
		const h = makeHarness()
		const undecryptable = (() => {
			const raw = narrowItem({ ...mockFile({ uuid: testUuid("old") }), meta: { type: "encrypted", data: "cipher" } })
			if (raw.type !== "file") {
				throw new Error("expected a file arm")
			}
			return raw
		})()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))

		await runPreviewSave(h.deps, { item: undecryptable, content: "x" })

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([undecryptable])
		expect(patched).toHaveLength(1)
		expect(patched[0]?.data.uuid).toBe(testUuid("new"))
	})

	it("returns an error outcome without patching when uploadFileBytes rejects", async () => {
		const h = makeHarness()
		const dto = sdkDto("FileNotFound")
		h.uploadFileBytes.mockRejectedValue(dto)
		const item = fileItem()

		const outcome = await runPreviewSave(h.deps, { item, content: "x" })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.patchListing).not.toHaveBeenCalled()
	})

	it("surfaces a parent-not-found worker throw (unresolvable parent) as a plain error outcome", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockRejectedValue(new Error("parent directory not found: missing-uuid"))
		const item = fileItem()

		const outcome = await runPreviewSave(h.deps, { item, content: "x" })

		expect(outcome).toEqual({
			status: "error",
			dto: {
				species: "plain",
				message: "parent directory not found: missing-uuid",
				label: "parent directory not found: missing-uuid"
			}
		})
		expect(h.patchListing).not.toHaveBeenCalled()
	})
})
