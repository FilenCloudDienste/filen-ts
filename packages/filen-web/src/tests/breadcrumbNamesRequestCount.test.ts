// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Dir, NormalDirsAndFiles, SharedDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import { InFlight } from "@filen/shared"
import type { ListDirectoryTarget } from "@/workers/sdk.worker"
import type { SharedPathHint } from "@/features/drive/lib/sharedPath"

const { resolveDirectoryName, listDirectory } = vi.hoisted(() => ({
	resolveDirectoryName: vi.fn<(uuid: string, hint?: SharedPathHint) => Promise<string | null>>(),
	listDirectory: vi.fn<(target: ListDirectoryTarget) => Promise<NormalDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { resolveDirectoryName, listDirectory } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { queryClient } from "@/queries/client"
import { cacheDirs, clearDirectoryCache, getCachedDir, getCachedName } from "@/features/drive/lib/cache"
import { lookupDirectoryName } from "@/features/drive/lib/directoryName"
import { useDirectoryListingQuery, useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import type { DriveVariant } from "@/features/drive/lib/preferences"

const ROOT = "root-0000-0000-0000-000000000000" as UuidStr
const ROLE: SharingRole = { Sharer: { email: "owner@filen.io", id: 42 } }

// The account's directories as the server holds them; getDirOptional and listDir answer from it.
const tree = new Map<string, Dir>()
const getDirOptional = vi.fn<(uuid: string) => Promise<Dir | undefined>>()
const listDir = vi.fn((dir: Dir) => Promise.resolve([...tree.values()].filter(child => child.parent === dir.uuid)))
const resolveSharedContext = vi.fn((_hint: SharedPathHint, uuid: string) =>
	Promise.resolve({ dir: sharedDir(uuid, `Shared ${uuid.slice(0, 4)}`), role: ROLE })
)
let ownedDirs = new InFlight<string, Dir | undefined>()

// The worker's wiring (sdk.worker.ts's resolveOwnedDir, listDirectory's uuid case, resolveDirectoryName)
// over the real dir cache, so a spy count is the SDK request count the worker would issue.
function resolveOwnedDir(uuid: string): Promise<Dir | undefined> {
	const cached = getCachedDir(uuid)

	if (cached !== undefined) {
		return Promise.resolve(cached)
	}

	return ownedDirs.coalesce(uuid, async () => {
		const dir = await getDirOptional(uuid)

		if (dir !== undefined) {
			cacheDirs([dir])
		}

		return dir
	})
}

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(uuid: string, parent: string): Dir {
	return {
		uuid: uuid as UuidStr,
		parent: parent as UuidStr,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: `Dir ${uuid.slice(0, 4)}` } }
	}
}

function sharedDir(uuid: string, name: string): SharedDir {
	return {
		inner: {
			uuid,
			parent: ROOT,
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name } }
		},
		sharedTag: true
	} as SharedDir
}

// A fresh owned chain under the drive root, `depth` levels deep. Unique per call: the query cache
// outlives a test.
let chainCounter = 0

function makeChain(depth: number): string[] {
	chainCounter++

	const uuids: string[] = []
	let parent: string = ROOT

	for (let level = 0; level < depth; level++) {
		const uuid = testUuid(`${chainCounter.toString().padStart(2, "0")}${level.toString().padStart(2, "0")}`)

		tree.set(uuid, mockDir(uuid, parent))
		uuids.push(uuid)
		parent = uuid
	}

	return uuids
}

function namesOf(uuids: readonly string[]): Record<string, string> {
	return Object.fromEntries(uuids.map(uuid => [uuid, `Dir ${uuid.slice(0, 4)}`]))
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children)
}

// What the drive route mounts for a splat: the current directory's listing and one crumb per uuid.
function renderDriveRoute(initial: string[], variant: DriveVariant = "drive") {
	return renderHook(
		({ uuids }) => ({
			listing: useDirectoryListingQuery(variant, uuids.at(-1) ?? null, uuids),
			names: useDirectoryNamesQuery(uuids, variant)
		}),
		{ wrapper, initialProps: { uuids: initial } }
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	clearDirectoryCache()
	ownedDirs = new InFlight()

	getDirOptional.mockImplementation(uuid => Promise.resolve(tree.get(uuid)))

	resolveDirectoryName.mockImplementation((uuid, hint) =>
		lookupDirectoryName(
			{
				getCachedName,
				lookupOwnedName: async ownedUuid => {
					await resolveOwnedDir(ownedUuid)

					return getCachedName(ownedUuid)
				},
				resolveSharedContext
			},
			uuid,
			hint
		)
	)

	listDirectory.mockImplementation(async target => {
		if (target.kind !== "uuid") {
			throw new Error(`unexpected listing target: ${target.kind}`)
		}

		const dir = await resolveOwnedDir(target.uuid)

		if (dir === undefined) {
			throw new Error(`directory not found: ${target.uuid}`)
		}

		const dirs = await listDir(dir)

		cacheDirs(dirs)

		return { dirs, files: [] }
	})
})

describe("breadcrumb names: SDK requests", () => {
	// No SDK call walks an ancestor chain in fewer requests: getItemPath issues one v3/dir per ancestor,
	// in sequence. So a cold deep link costs one lookup per crumb, run in parallel, and the current
	// directory's is shared with its own listing.
	it.each([1, 2, 3, 5])("cold deep link %i levels deep: one getDirOptional per level, the current one shared", async depth => {
		const uuids = makeChain(depth)
		const { result, unmount } = renderDriveRoute(uuids)

		await waitFor(() => {
			expect(result.current.names.status).toBe("success")
		})
		await waitFor(() => {
			expect(result.current.listing.status).toBe("success")
		})

		expect(result.current.names.data).toEqual(namesOf(uuids))
		expect(getDirOptional).toHaveBeenCalledTimes(depth)
		expect(new Set(getDirOptional.mock.calls.map(([uuid]) => uuid))).toEqual(new Set(uuids))
		expect(listDir).toHaveBeenCalledTimes(1)

		unmount()
	})

	it("warm navigation resolves every crumb without a request", async () => {
		const uuids = makeChain(4)
		const parent = uuids.slice(0, 3)
		const { result, rerender, unmount } = renderDriveRoute(parent)

		await waitFor(() => {
			expect(result.current.names.status).toBe("success")
		})
		await waitFor(() => {
			expect(result.current.listing.status).toBe("success")
		})

		const lookups = resolveDirectoryName.mock.calls.length
		const dirLookups = getDirOptional.mock.calls.length

		// Into a child: its name is in the parent listing just read.
		rerender({ uuids })
		await waitFor(() => {
			expect(result.current.names.data).toEqual(namesOf(uuids))
		})
		await waitFor(() => {
			expect(result.current.listing.status).toBe("success")
		})

		// And back up: every crumb is already cached under its own uuid.
		rerender({ uuids: uuids.slice(0, 2) })
		await waitFor(() => {
			expect(result.current.listing.status).toBe("success")
		})

		expect(result.current.names.data).toEqual(namesOf(uuids.slice(0, 2)))
		expect(resolveDirectoryName).toHaveBeenCalledTimes(lookups)
		expect(getDirOptional).toHaveBeenCalledTimes(dirLookups)

		unmount()
	})

	it("partially warm chain: only the uncached ancestors are looked up", async () => {
		const uuids = makeChain(5)
		const warm = uuids.slice(0, 2)

		// An earlier listing this session returned the first two levels.
		cacheDirs(warm.map(uuid => tree.get(uuid)).filter(dir => dir !== undefined))

		const { result, unmount } = renderDriveRoute(uuids)

		await waitFor(() => {
			expect(result.current.names.status).toBe("success")
		})
		await waitFor(() => {
			expect(result.current.listing.status).toBe("success")
		})

		expect(result.current.names.data).toEqual(namesOf(uuids))
		expect(getDirOptional).toHaveBeenCalledTimes(3)
		expect(getDirOptional.mock.calls.map(([uuid]) => uuid)).not.toContain(warm[0])
		expect(getDirOptional.mock.calls.map(([uuid]) => uuid)).not.toContain(warm[1])

		unmount()
	})

	it("a failed lookup leaves only that crumb unresolved", async () => {
		const uuids = makeChain(4)
		const failing = uuids[1]

		getDirOptional.mockImplementation(uuid =>
			uuid === failing ? Promise.reject(new Error("network")) : Promise.resolve(tree.get(uuid))
		)

		const { result, unmount } = renderHook(() => useDirectoryNamesQuery(uuids), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(result.current.data).toEqual(namesOf(uuids.filter(uuid => uuid !== failing)))
		expect(getDirOptional).toHaveBeenCalledTimes(4)

		unmount()
	})

	it.each(["sharedIn", "sharedOut"] as const)("%s: every crumb resolves through the share walk, never an owned lookup", async variant => {
		const uuids = [testUuid(`${variant}1`), testUuid(`${variant}2`), testUuid(`${variant}3`)]
		const { result, unmount } = renderHook(() => useDirectoryNamesQuery(uuids, variant), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(resolveDirectoryName.mock.calls).toEqual(uuids.map((uuid, index) => [uuid, { variant, path: uuids.slice(0, index + 1) }]))
		expect(resolveSharedContext).toHaveBeenCalledTimes(3)
		expect(getDirOptional).not.toHaveBeenCalled()

		unmount()
	})
})
