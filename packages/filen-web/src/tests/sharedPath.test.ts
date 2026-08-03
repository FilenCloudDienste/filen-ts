import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SharedDir, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import { type SharedDirContext } from "@/features/drive/lib/cache"
import { resolveSharedDirContext, type SharedPathDeps } from "@/features/drive/lib/sharedPath"

const ROLE: SharingRole = { Sharer: { email: "owner@filen.io", id: 42 } }

function sharedRootDir(uuid: string): SharedRootDir {
	return {
		inner: { uuid, color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name: uuid } } },
		sharingRole: ROLE,
		writeAccess: true
	} as SharedRootDir
}

function sharedDir(uuid: string, parent: string): SharedDir {
	return {
		inner: {
			uuid,
			parent,
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name: uuid } }
		},
		sharedTag: true
	} as SharedDir
}

// A stand-in for the worker's own in-memory share-context map, so the walk's caching side effects are
// observable exactly the way the worker sees them.
function makeDeps(options: {
	seeded?: Record<string, SharedDirContext>
	roots?: SharedRootDir[]
	children?: Record<string, SharedDir[]>
}): SharedPathDeps & { contexts: Map<string, SharedDirContext> } {
	const contexts = new Map<string, SharedDirContext>(Object.entries(options.seeded ?? {}))

	return {
		contexts,
		getContext: vi.fn((uuid: string) => contexts.get(uuid)),
		listRootDirs: vi.fn(() => Promise.resolve(options.roots ?? [])),
		cacheRootContexts: vi.fn((dirs: readonly SharedRootDir[]) => {
			for (const dir of dirs) {
				contexts.set(dir.inner.uuid, { dir, role: dir.sharingRole })
			}
		}),
		listChildDirs: vi.fn((context: SharedDirContext) => {
			const parentUuid = "inner" in context.dir ? context.dir.inner.uuid : ""
			return Promise.resolve(options.children?.[parentUuid] ?? [])
		}),
		cacheChildContext: vi.fn((uuid: string, context: SharedDirContext) => {
			contexts.set(uuid, context)
		})
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("resolveSharedDirContext", () => {
	it("returns the cached context without any network call", async () => {
		const cached: SharedDirContext = { dir: sharedRootDir("target"), role: ROLE }
		const deps = makeDeps({ seeded: { target: cached } })

		await expect(resolveSharedDirContext(deps, "target", ["root", "target"])).resolves.toBe(cached)
		expect(deps.listRootDirs).not.toHaveBeenCalled()
		expect(deps.listChildDirs).not.toHaveBeenCalled()
	})

	it("cold walk: seeds the shared roots, then lists each ancestor in order, and resolves the target", async () => {
		const deps = makeDeps({
			roots: [sharedRootDir("root")],
			children: { root: [sharedDir("mid", "root")], mid: [sharedDir("target", "mid")] }
		})

		const resolved = await resolveSharedDirContext(deps, "target", ["root", "mid", "target"])

		expect(resolved?.role).toEqual(ROLE)
		expect(deps.listRootDirs).toHaveBeenCalledTimes(1)
		expect(deps.listChildDirs).toHaveBeenCalledTimes(2)
		// Root first, then the mid segment — the chain has to be walked in order.
		expect(deps.contexts.get("mid")).toBeDefined()
		expect(deps.contexts.get("target")).toBeDefined()
	})

	it("skips a segment whose child context is already cached", async () => {
		const deps = makeDeps({
			seeded: { mid: { dir: sharedDir("mid", "root"), role: ROLE } },
			roots: [sharedRootDir("root")],
			children: { root: [sharedDir("mid", "root")], mid: [sharedDir("target", "mid")] }
		})

		const resolved = await resolveSharedDirContext(deps, "target", ["root", "mid", "target"])

		expect(resolved).toBeDefined()
		// Only the mid segment's own children were listed — root's were already covered by the cache hit.
		expect(deps.listChildDirs).toHaveBeenCalledTimes(1)
	})

	it("returns undefined when a mid-chain segment can't be resolved (a revoked share)", async () => {
		const deps = makeDeps({ roots: [], children: {} })

		await expect(resolveSharedDirContext(deps, "target", ["root", "mid", "target"])).resolves.toBeUndefined()
		expect(deps.listChildDirs).not.toHaveBeenCalled()
	})

	it("returns undefined when the path's last segment isn't the requested uuid", async () => {
		const deps = makeDeps({ roots: [sharedRootDir("root")] })

		await expect(resolveSharedDirContext(deps, "target", ["root", "other"])).resolves.toBeUndefined()
		expect(deps.listRootDirs).not.toHaveBeenCalled()
	})

	it("returns undefined for an empty path", async () => {
		const deps = makeDeps({ roots: [sharedRootDir("root")] })

		await expect(resolveSharedDirContext(deps, "target", [])).resolves.toBeUndefined()
		expect(deps.listRootDirs).not.toHaveBeenCalled()
	})

	it("resolves a target that IS a shared root (one-segment path) off the root listing alone", async () => {
		const deps = makeDeps({ roots: [sharedRootDir("target")] })

		const resolved = await resolveSharedDirContext(deps, "target", ["target"])

		expect(resolved?.role).toEqual(ROLE)
		expect(deps.listChildDirs).not.toHaveBeenCalled()
	})
})
