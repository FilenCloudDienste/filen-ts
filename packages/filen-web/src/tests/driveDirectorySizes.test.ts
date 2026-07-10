import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, UuidStr, DirSizeResponse } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { directorySizeQueryKey } from "@/features/drive/queries/drive"
import {
	MAX_DIRECTORY_SIZE_PREFETCH,
	collectDirectorySizes,
	directorySizePrefetchTargets,
	isDirectorySizeItem,
	isDirectorySizeSuccessEvent,
	type DirectorySizeCacheEvent
} from "@/features/drive/hooks/useDriveDirectorySizes.logic"

// queries/drive pulls in the SDK worker (`?worker`) and the real query client (sqlite persister) —
// neither resolves under node vitest, so mock the module boundary. The logic under test takes a
// QueryClient by PARAMETER (see collectDirectorySizes) and never touches sdkApi, so bare stubs suffice.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

beforeEach(() => {
	vi.clearAllMocks()
})

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable label into a satisfying shape, mirroring drive.test.ts's own uuid fixtures.
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

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(label: string): DriveItem {
	return narrowItem(mockDir({ uuid: testUuid(label) }))
}

function fileItem(label: string): DriveItem {
	return narrowItem(mockFile({ uuid: testUuid(label) }))
}

describe("isDirectorySizeItem", () => {
	it("accepts an owned directory", () => {
		expect(isDirectorySizeItem(dirItem("d"))).toBe(true)
	})

	it("rejects a file", () => {
		expect(isDirectorySizeItem(fileItem("f"))).toBe(false)
	})

	// The guard reads only the discriminant `.type`, so the shared directory arms follow the same
	// branch — the size query dispatches on them identically (item.ts's toAnyDirWithContext accepts
	// exactly these three). Minimal discriminant-only fixtures, mirroring driveItem.test.ts's own
	// `as unknown as` shapes for values whose non-discriminant fields are irrelevant to what's tested.
	it("accepts the shared directory arms", () => {
		expect(isDirectorySizeItem({ type: "sharedDirectory" } as unknown as DriveItem)).toBe(true)
		expect(isDirectorySizeItem({ type: "sharedRootDirectory" } as unknown as DriveItem)).toBe(true)
	})

	it("rejects the shared file arms", () => {
		expect(isDirectorySizeItem({ type: "sharedFile" } as unknown as DriveItem)).toBe(false)
		expect(isDirectorySizeItem({ type: "sharedRootFile" } as unknown as DriveItem)).toBe(false)
	})
})

describe("directorySizePrefetchTargets", () => {
	it("keeps directories, drops files, preserves input order", () => {
		const a = dirItem("a")
		const b = fileItem("b")
		const c = dirItem("c")

		const targets = directorySizePrefetchTargets([a, b, c])

		expect(targets.map(t => t.data.uuid)).toEqual([a.data.uuid, c.data.uuid])
	})

	it("returns an empty list when the listing has no directories", () => {
		expect(directorySizePrefetchTargets([fileItem("f1"), fileItem("f2")])).toEqual([])
	})

	// DEVIATION FROM MOBILE (unbounded): a pathologically large listing's directories are prefetched
	// only up to the cap; the rest fall back to the sort's deterministic 0n size.
	it("caps the number of prefetch targets at MAX_DIRECTORY_SIZE_PREFETCH", () => {
		const items = Array.from({ length: MAX_DIRECTORY_SIZE_PREFETCH + 5 }, (_, i) => dirItem(`dir${String(i)}`))

		expect(directorySizePrefetchTargets(items)).toHaveLength(MAX_DIRECTORY_SIZE_PREFETCH)
	})
})

describe("collectDirectorySizes", () => {
	function seed(client: QueryClient, item: DriveItem, size: DirSizeResponse): void {
		client.setQueryData(directorySizeQueryKey(item.data.uuid), size)
	}

	it("assembles a uuid -> bytes map from resolved sizes, converting bigint to number", () => {
		const client = new QueryClient()
		const a = dirItem("a")
		const b = dirItem("b")

		seed(client, a, { size: 4_096n, files: 3n, dirs: 1n })
		seed(client, b, { size: 8_192n, files: 5n, dirs: 2n })

		const sizes = collectDirectorySizes([a, b], client)

		expect(sizes).toBeDefined()
		expect(sizes?.get(a.data.uuid)).toBe(4096)
		expect(sizes?.get(b.data.uuid)).toBe(8192)
	})

	it("omits directories whose size has not resolved yet", () => {
		const client = new QueryClient()
		const resolved = dirItem("resolved")
		const pending = dirItem("pending")

		seed(client, resolved, { size: 512n, files: 1n, dirs: 0n })

		const sizes = collectDirectorySizes([resolved, pending], client)

		expect(sizes?.has(resolved.data.uuid)).toBe(true)
		expect(sizes?.has(pending.data.uuid)).toBe(false)
	})

	it("ignores files even when a stray entry sits under their uuid", () => {
		const client = new QueryClient()
		const dir = dirItem("dir")
		const file = fileItem("file")

		seed(client, dir, { size: 100n, files: 1n, dirs: 0n })
		// A file uuid should never carry a directory-size entry, but even if one did the collector
		// must not surface it — only directory arms are read.
		client.setQueryData(directorySizeQueryKey(file.data.uuid), { size: 999n, files: 0n, dirs: 0n })

		const sizes = collectDirectorySizes([dir, file], client)

		expect(sizes?.has(file.data.uuid)).toBe(false)
		expect(sizes?.get(dir.data.uuid)).toBe(100)
	})

	it("returns undefined when no directory size has resolved (sort takes its zero-cost path)", () => {
		const client = new QueryClient()

		expect(collectDirectorySizes([dirItem("a"), fileItem("f")], client)).toBeUndefined()
	})
})

describe("isDirectorySizeSuccessEvent", () => {
	function event(overrides: Partial<DirectorySizeCacheEvent>): DirectorySizeCacheEvent {
		return {
			type: "updated",
			action: { type: "success" },
			query: { queryKey: directorySizeQueryKey(testUuid("d")) },
			...overrides
		}
	}

	it("matches a successful directory-size update", () => {
		expect(isDirectorySizeSuccessEvent(event({}))).toBe(true)
	})

	it("ignores a non-success action (e.g. an error or a fetch start)", () => {
		expect(isDirectorySizeSuccessEvent(event({ action: { type: "error" } }))).toBe(false)
	})

	it("ignores a non-updated event (e.g. added/removed)", () => {
		expect(isDirectorySizeSuccessEvent(event({ type: "added" }))).toBe(false)
	})

	it("ignores a successful update for a different query entity", () => {
		expect(isDirectorySizeSuccessEvent(event({ query: { queryKey: ["drive", "listing", { variant: "drive", uuid: null }] } }))).toBe(
			false
		)
	})

	it("ignores a successful update in a different domain", () => {
		expect(isDirectorySizeSuccessEvent(event({ query: { queryKey: ["notes", "dirSize", testUuid("d")] } }))).toBe(false)
	})

	it("tolerates an event with no action field", () => {
		expect(isDirectorySizeSuccessEvent({ type: "updated", query: { queryKey: directorySizeQueryKey(testUuid("d")) } })).toBe(false)
	})
})
