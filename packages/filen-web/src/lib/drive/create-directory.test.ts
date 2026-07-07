import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import { runCreateDirectory, type CreateDirectoryDeps } from "@/lib/drive/create-directory"
import type { DriveItem } from "@/lib/drive/item"
import type { ErrorDTO } from "@/lib/sdk/errors"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring queries/drive.test.ts's own fixture.
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

// Worker-boundary errors arrive as plain DTOs (the Comlink proxy throws toErrorDTO output), so the
// rejections here are literal DTO objects, exactly the shape the helper sees in production.
function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

// All collaborators injected — no module mocks, mirroring login-attempt.test.ts/reset-attempt.test.ts.
function makeHarness() {
	const createDirectory = vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>()
	const patchListing = vi.fn<(parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void>()
	const deps: CreateDirectoryDeps = { createDirectory, patchListing }
	return { deps, createDirectory, patchListing }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runCreateDirectory (injected deps, no worker or query client)", () => {
	it("creates, narrows and patches the listing on success", async () => {
		const h = makeHarness()
		h.createDirectory.mockResolvedValue(mockDir({ uuid: testUuid("new") }))

		const outcome = await runCreateDirectory(h.deps, "parent-uuid", "Docs")

		expect(outcome.status).toBe("success")
		if (outcome.status !== "success") {
			throw new Error("expected success")
		}
		expect(outcome.item.data.uuid).toBe(testUuid("new"))
		expect(h.createDirectory).toHaveBeenCalledTimes(1)
		expect(h.createDirectory).toHaveBeenCalledWith("parent-uuid", "Docs")
		expect(h.patchListing).toHaveBeenCalledTimes(1)
		expect(h.patchListing).toHaveBeenCalledWith("parent-uuid", expect.any(Function))
	})

	it("creates at the drive root when parentUuid is null", async () => {
		const h = makeHarness()
		h.createDirectory.mockResolvedValue(mockDir())

		await runCreateDirectory(h.deps, null, "Docs")

		expect(h.createDirectory).toHaveBeenCalledWith(null, "Docs")
		expect(h.patchListing).toHaveBeenCalledWith(null, expect.any(Function))
	})

	it("the patch updater upserts the created item (append when nothing collides)", async () => {
		const h = makeHarness()
		h.createDirectory.mockResolvedValue(mockDir({ uuid: testUuid("new") }))

		await runCreateDirectory(h.deps, "parent-uuid", "Docs")

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([])
		expect(patched).toHaveLength(1)
		expect(patched[0]?.data.uuid).toBe(testUuid("new"))
	})

	it("the patch updater replaces, not duplicates, a stale row on the idempotent-existing-directory case", async () => {
		// createDirectory's backend is idempotent — a name that already exists returns THAT
		// directory's own uuid. If the caller's cache already has a (possibly stale) row for it, the
		// updater must replace it in place, not append a second copy.
		const h = makeHarness()
		h.createDirectory.mockResolvedValue(mockDir({ uuid: testUuid("same"), favorited: true }))

		await runCreateDirectory(h.deps, "parent-uuid", "Docs")

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const staleItem: DriveItem = {
			type: "directory",
			data: {
				...mockDir({ uuid: testUuid("same"), favorited: false }),
				size: 0n,
				undecryptable: false,
				decryptedMeta: { name: "Documents" }
			}
		}
		const patched = updater([staleItem])
		expect(patched).toHaveLength(1)
		expect(patched[0]?.data.favorited).toBe(true)
	})

	it("returns an error outcome without patching when createDirectory rejects (e.g. a name clash with a file)", async () => {
		const h = makeHarness()
		const dto = sdkDto("DirCreateFileExists")
		h.createDirectory.mockRejectedValue(dto)

		const outcome = await runCreateDirectory(h.deps, "parent-uuid", "Docs")

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.patchListing).not.toHaveBeenCalled()
	})

	it("normalizes a plain Error rejection through asErrorDTO", async () => {
		const h = makeHarness()
		h.createDirectory.mockRejectedValue(new Error("parent directory not found: missing-uuid"))

		const outcome = await runCreateDirectory(h.deps, "missing-uuid", "Docs")

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
