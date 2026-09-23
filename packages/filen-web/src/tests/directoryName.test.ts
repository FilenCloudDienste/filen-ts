import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SharedDir, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import { type SharedDirContext } from "@/features/drive/lib/cache"
import { lookupDirectoryName, type DirectoryNameDeps } from "@/features/drive/lib/directoryName"
import {
	coalesceSharedPathDeps,
	createSharedPathInFlight,
	resolveSharedDirContext,
	type SharedPathDeps
} from "@/features/drive/lib/sharedPath"

const ROLE: SharingRole = { Sharer: { email: "owner@filen.io", id: 42 } }

function sharedRootDir(uuid: string, name: string): SharedRootDir {
	return {
		inner: { uuid, color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name } } },
		sharingRole: ROLE,
		writeAccess: false
	} as SharedRootDir
}

function sharedDir(uuid: string, parent: string, name: string): SharedDir {
	return {
		inner: {
			uuid,
			parent,
			color: "default",
			timestamp: 1_700_000_000_000n,
			favorited: false,
			meta: { type: "decoded", data: { name } }
		},
		sharedTag: true
	} as SharedDir
}

function makeDeps(overrides: Partial<DirectoryNameDeps> = {}): DirectoryNameDeps {
	return {
		getCachedName: vi.fn(() => undefined),
		lookupOwnedName: vi.fn(() => Promise.resolve(undefined)),
		resolveSharedContext: vi.fn(() => Promise.resolve(undefined)),
		...overrides
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("lookupDirectoryName", () => {
	it("returns a worker-cached name without any lookup", async () => {
		const deps = makeDeps({ getCachedName: vi.fn(() => "Cached") })

		await expect(lookupDirectoryName(deps, "a")).resolves.toBe("Cached")
		await expect(lookupDirectoryName(deps, "a", { variant: "sharedIn", path: ["a"] })).resolves.toBe("Cached")
		expect(deps.lookupOwnedName).not.toHaveBeenCalled()
		expect(deps.resolveSharedContext).not.toHaveBeenCalled()
	})

	it("owned: resolves through the owned lookup and never walks a share", async () => {
		const deps = makeDeps({ lookupOwnedName: vi.fn(() => Promise.resolve("Documents")) })

		await expect(lookupDirectoryName(deps, "a")).resolves.toBe("Documents")
		expect(deps.lookupOwnedName).toHaveBeenCalledExactlyOnceWith("a")
		expect(deps.resolveSharedContext).not.toHaveBeenCalled()
	})

	it.each(["sharedIn", "sharedOut"] as const)(
		"%s: resolves through the share walk and never the owned (v3/dir) lookup",
		async variant => {
			const context: SharedDirContext = { dir: sharedDir("b", "a", "Holiday"), role: ROLE }
			const deps = makeDeps({ resolveSharedContext: vi.fn(() => Promise.resolve(context)) })
			const hint = { variant, path: ["a", "b"] }

			await expect(lookupDirectoryName(deps, "b", hint)).resolves.toBe("Holiday")
			expect(deps.resolveSharedContext).toHaveBeenCalledExactlyOnceWith(hint, "b")
			expect(deps.lookupOwnedName).not.toHaveBeenCalled()
		}
	)

	it("reads a shared ROOT directory's name off its inner meta too", async () => {
		const deps = makeDeps({ resolveSharedContext: vi.fn(() => Promise.resolve({ dir: sharedRootDir("a", "Team"), role: ROLE })) })

		await expect(lookupDirectoryName(deps, "a", { variant: "sharedIn", path: ["a"] })).resolves.toBe("Team")
	})

	it("an unreachable or undecryptable shared directory is null, never an owned fallback", async () => {
		const undecryptable = {
			...sharedDir("b", "a", "x"),
			inner: { ...sharedDir("b", "a", "x").inner, meta: { type: "encrypted", data: "x" } }
		}
		const deps = makeDeps({
			resolveSharedContext: vi
				.fn<DirectoryNameDeps["resolveSharedContext"]>()
				.mockResolvedValueOnce(undefined)
				.mockResolvedValueOnce({ dir: undecryptable as SharedDir, role: ROLE })
		})

		await expect(lookupDirectoryName(deps, "b", { variant: "sharedIn", path: ["a", "b"] })).resolves.toBeNull()
		await expect(lookupDirectoryName(deps, "b", { variant: "sharedIn", path: ["a", "b"] })).resolves.toBeNull()
		expect(deps.lookupOwnedName).not.toHaveBeenCalled()
	})

	it("a rejected lookup degrades to null instead of failing the breadcrumb", async () => {
		const deps = makeDeps({ lookupOwnedName: vi.fn(() => Promise.reject(new Error("FolderNotFound"))) })

		await expect(lookupDirectoryName(deps, "a")).resolves.toBeNull()
	})

	// The worker's real wiring for a cold /shared-in/a/b/c: the listing's own walk plus one lookup per
	// crumb, all at once, over one coalesced context map. One request per chain level in total — the
	// crumbs add none on top of the listing's walk, and the owned lookup is never touched.
	it("cold shared deep URL: crumbs and the listing walk share one request per level", async () => {
		const contexts = new Map<string, SharedDirContext>()
		const raw: SharedPathDeps = {
			getContext: uuid => contexts.get(uuid),
			listRootDirs: vi.fn(() => Promise.resolve([sharedRootDir("a", "A")])),
			cacheRootContexts: dirs => {
				for (const dir of dirs) {
					contexts.set(dir.inner.uuid, { dir, role: dir.sharingRole })
				}
			},
			listChildDirs: vi.fn((context: SharedDirContext) => {
				const children: Record<string, SharedDir[]> = { a: [sharedDir("b", "a", "B")], b: [sharedDir("c", "b", "C")] }

				return Promise.resolve(children[context.dir.inner.uuid] ?? [])
			}),
			cacheChildContext: (uuid, context) => {
				contexts.set(uuid, context)
			}
		}
		const walkDeps = coalesceSharedPathDeps(raw, createSharedPathInFlight())
		const deps = makeDeps({ resolveSharedContext: (hint, uuid) => resolveSharedDirContext(walkDeps, uuid, hint.path) })
		const path = ["a", "b", "c"]

		const [listingContext, ...names] = await Promise.all([
			resolveSharedDirContext(walkDeps, "c", path),
			...path.map((uuid, index) => lookupDirectoryName(deps, uuid, { variant: "sharedIn", path: path.slice(0, index + 1) }))
		])

		expect(listingContext).toBeDefined()
		expect(names).toEqual(["A", "B", "C"])
		expect(raw.listRootDirs).toHaveBeenCalledTimes(1)
		expect(raw.listChildDirs).toHaveBeenCalledTimes(2)
		expect(deps.lookupOwnedName).not.toHaveBeenCalled()

		// Click-through afterwards: everything is in the context map, so nothing lists again.
		await expect(lookupDirectoryName(deps, "c", { variant: "sharedIn", path })).resolves.toBe("C")
		expect(raw.listRootDirs).toHaveBeenCalledTimes(1)
		expect(raw.listChildDirs).toHaveBeenCalledTimes(2)
	})
})
