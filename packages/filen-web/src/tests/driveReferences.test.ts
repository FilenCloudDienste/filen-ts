import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DriveItem } from "@/features/drive/lib/item"

// The drive's references: the model's directory as a cached listing holds it, else its parent listed once (a model
// opened from Recents, search or Favorites); a subdirectory listed once, only when named; each found file read whole.

interface CachedQuery {
	queryKey: readonly unknown[]
	state: { data: DriveItem[] }
}

const { cached, fetchDirectoryListing, loadOriginBytes } = vi.hoisted(() => ({
	cached: [] as CachedQuery[],
	fetchDirectoryListing: vi.fn<(variant: string, uuid: string | null) => Promise<DriveItem[]>>(),
	loadOriginBytes: vi.fn(() => Promise.resolve(new Uint8Array(4)))
}))

vi.mock("@/features/drive/queries/drive", () => ({ fetchDirectoryListing, DRIVE_LISTING_KEY_PREFIX: ["drive", "listing"] }))
vi.mock("@/queries/patch", () => ({ cachedQueriesWithPrefix: () => cached }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root" }))
vi.mock("@/features/preview/lib/origin/loadBytes", () => ({ loadOriginBytes }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))

function file(name: string, parent = "models", size = 4n): DriveItem {
	return { type: "file", data: { uuid: `file-${name}`, parent, size, decryptedMeta: { name } } } as unknown as DriveItem
}

function directory(name: string, uuid: string): DriveItem {
	return { type: "directory", data: { uuid, parent: "models", decryptedMeta: { name } } } as unknown as DriveItem
}

const MODEL = file("mesh.obj")

function listing(variant: string, uuid: string | null, rows: DriveItem[]): CachedQuery {
	return { queryKey: ["drive", "listing", { variant, uuid }], state: { data: rows } }
}

beforeEach(() => {
	cached.length = 0
	fetchDirectoryListing.mockImplementation((_variant, uuid) =>
		Promise.resolve(
			uuid === "models"
				? [MODEL, file("mesh.mtl"), directory("Textures", "textures")]
				: uuid === "textures"
					? [file("wood.png", "textures")]
					: []
		)
	)
})

describe("driveReferences", () => {
	it("lists the model's parent once when no cached listing holds it, and a subdirectory only when named", async () => {
		const { driveReferences } = await import("@/features/preview/lib/referenceResolver")
		const resolve = driveReferences(MODEL)

		const mtl = await resolve("mesh.mtl")
		const wood = await resolve("textures/WOOD.png")

		expect(mtl.status).toBe("found")
		expect(wood.status).toBe("found")
		expect(await resolve("missing.png")).toEqual({ status: "missing" })
		expect(fetchDirectoryListing.mock.calls).toEqual([
			["drive", "models"],
			["drive", "textures"]
		])

		if (wood.status === "found") {
			await wood.read(100, new AbortController().signal)
			// Read whole, never kept in the preview cache, within what the viewer has left.
			expect(loadOriginBytes).toHaveBeenCalledWith(
				{ kind: "file", file: expect.objectContaining({ uuid: "file-wood.png" }) as unknown },
				expect.any(String),
				expect.objectContaining({ access: "authed", cap: 100, store: false })
			)
		}
	})

	it("uses the cached listing that holds the model, listing nothing", async () => {
		const { driveReferences } = await import("@/features/preview/lib/referenceResolver")

		cached.push(listing("drive", "models", [MODEL, file("mesh.mtl")]))

		expect((await driveReferences(MODEL)("mesh.mtl")).status).toBe("found")
		expect(fetchDirectoryListing).not.toHaveBeenCalled()
	})

	it("never lists a shared directory through the SDK, only reads one the cache holds", async () => {
		const { driveReferences } = await import("@/features/preview/lib/referenceResolver")

		cached.push(listing("sharedIn", "share", [MODEL, directory("Textures", "shared-textures")]))

		expect((await driveReferences(MODEL)("Textures/wood.png")).status).toBe("missing")
		expect(fetchDirectoryListing).not.toHaveBeenCalled()

		cached.push(listing("sharedIn", "shared-textures", [file("wood.png", "shared-textures")]))

		expect((await driveReferences(MODEL)("Textures/wood.png")).status).toBe("found")
	})

	it("lists the drive's root by its own target", async () => {
		const { driveReferences } = await import("@/features/preview/lib/referenceResolver")
		const top = file("top.obj", "root")

		await driveReferences(top)("a.mtl")

		expect(fetchDirectoryListing).toHaveBeenCalledWith("drive", null)
	})
})
