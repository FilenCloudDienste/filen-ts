import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { normalizeTextFileName, runCreateTextFile, type CreateTextFileDeps } from "@/features/drive/lib/createTextFile"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring createDirectory.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		chunks: 0n,
		size: 0n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1_700_000_000_000n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: "Untitled.txt", mime: "text/plain", size: 0n, modified: 0n, key: "test-key", version: 2 }
		},
		...overrides
	}
}

// Worker-boundary errors arrive as plain DTOs (the Comlink proxy throws toErrorDTO output), so the
// rejections here are literal DTO objects, exactly the shape the helper sees in production.
function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

// All collaborators injected — no module mocks, mirroring createDirectory.test.ts's own harness.
function makeHarness() {
	const uploadFileBytes = vi.fn<(parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>>()
	const patchListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()
	const deps: CreateTextFileDeps = { uploadFileBytes, patchListing }
	return { deps, uploadFileBytes, patchListing }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("normalizeTextFileName", () => {
	it("appends .txt when the name has no extension", () => {
		expect(normalizeTextFileName("notes")).toBe("notes.txt")
	})

	it("leaves an explicit extension untouched", () => {
		expect(normalizeTextFileName("notes.md")).toBe("notes.md")
	})

	it("appends .txt for a dotfile (no real extension by extensionOf's own leading-dot exclusion)", () => {
		expect(normalizeTextFileName(".gitignore")).toBe(".gitignore.txt")
	})

	it("is case-preserving and treats any non-empty suffix after the last dot as a real extension", () => {
		expect(normalizeTextFileName("archive.tar.gz")).toBe("archive.tar.gz")
		expect(normalizeTextFileName("README.TXT")).toBe("README.TXT")
	})
})

describe("runCreateTextFile (injected deps, no worker or query client)", () => {
	it("uploads a zero-byte text/plain buffer, narrows and patches the listing on success", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))

		const outcome = await runCreateTextFile(h.deps, "parent-uuid", "notes.txt")

		expect(outcome.status).toBe("success")
		if (outcome.status !== "success") {
			throw new Error("expected success")
		}
		expect(outcome.item.data.uuid).toBe(testUuid("new"))
		expect(h.uploadFileBytes).toHaveBeenCalledTimes(1)
		const [parentArg, dataArg, nameArg, mimeArg] = h.uploadFileBytes.mock.calls[0] ?? []
		expect(parentArg).toBe("parent-uuid")
		expect(dataArg).toEqual(new Uint8Array(0))
		expect(nameArg).toBe("notes.txt")
		expect(mimeArg).toBe("text/plain")
		expect(h.patchListing).toHaveBeenCalledTimes(1)
		expect(h.patchListing).toHaveBeenCalledWith("parent-uuid", expect.any(Function))
	})

	it("creates at the drive root when parentUuid is null", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile())

		await runCreateTextFile(h.deps, null, "notes.txt")

		expect(h.uploadFileBytes).toHaveBeenCalledWith(null, expect.any(Uint8Array), "notes.txt", "text/plain")
		expect(h.patchListing).toHaveBeenCalledWith(null, expect.any(Function))
	})

	it("the patch updater upserts the created item (append when nothing collides)", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))

		await runCreateTextFile(h.deps, "parent-uuid", "notes.txt")

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([])
		expect(patched).toHaveLength(1)
		expect(patched[0]?.data.uuid).toBe(testUuid("new"))
	})

	it("returns an error outcome without patching when uploadFileBytes rejects (e.g. a name clash with a directory)", async () => {
		const h = makeHarness()
		const dto = sdkDto("UploadFileDirExists")
		h.uploadFileBytes.mockRejectedValue(dto)

		const outcome = await runCreateTextFile(h.deps, "parent-uuid", "notes.txt")

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.patchListing).not.toHaveBeenCalled()
	})

	it("normalizes a plain Error rejection through asErrorDTO", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockRejectedValue(new Error("parent directory not found: missing-uuid"))

		const outcome = await runCreateTextFile(h.deps, "missing-uuid", "notes.txt")

		expect(outcome).toEqual({
			status: "error",
			dto: {
				species: "plain",
				message: "parent directory not found: missing-uuid",
				label: "parent directory not found: missing-uuid"
			}
		})
	})
})
