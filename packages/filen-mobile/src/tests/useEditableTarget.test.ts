// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

// Raw files carry their parent as a plain uuid here; directories are cached as { uuid } stand-ins.
const { cacheState, getDirOptional } = vi.hoisted(() => ({
	cacheState: {
		files: new Map<string, unknown>(),
		dirs: new Map<string, { uuid: string }>(),
		linkedDirs: new Map<string, unknown>()
	},
	getDirOptional: vi.fn<(uuid: string) => Promise<unknown>>()
}))

vi.mock("@shopify/flash-list", async () => {
	const { useState } = await import("react")

	return { useRecyclingState: (initial: unknown) => useState(initial) }
})
vi.mock("zustand/shallow", async () => await import("@/tests/mocks/zustandShallow"))
vi.mock("@/stores/useDrivePreview.store", () => {
	const state = { drivePath: { type: "drive", uuid: null }, setCurrentItem: vi.fn() }

	return { default: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) }
})
vi.mock("@/components/drivePreview/gallery", () => ({
	galleryItemKey: (item: { data: { data: { uuid: string } } }) => item.data.data.uuid
}))
vi.mock("@filen/sdk-rs", () => ({
	AnyDirWithContext: {
		Normal: class {
			public readonly tag = "Normal"
			public readonly inner: unknown[]

			public constructor(dir: unknown) {
				this.inner = [dir]
			}
		}
	}
}))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: string) => parent,
	unwrapDirMeta: (dir: unknown) => dir,
	unwrappedDirIntoDriveItem: (dir: unknown) => ({ type: "directory", data: dir }),
	getRealDriveItemParent: ({ item }: { item: { data: { parent: string } } }) => {
		const dir = cacheState.dirs.get(item.data.parent)

		return dir ? { tag: "Normal", inner: [dir] } : null
	}
}))
vi.mock("@/lib/cache", () => ({
	default: {
		rootUuid: "root",
		fileUuidToNormalFile: cacheState.files,
		directoryUuidToAnyNormalDir: cacheState.dirs,
		directoryUuidToAnyLinkedDirWithMeta: cacheState.linkedDirs,
		cacheDriveItem: (item: { data: { uuid: string } }) => cacheState.files.set(item.data.uuid, item.data),
		cacheNewNormalDir: (dir: { uuid: string }) => cacheState.dirs.set(dir.uuid, dir),
		forgetItem: vi.fn()
	}
}))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: () => Promise.resolve({ authedSdkClient: { getDirOptional } }) } }))
vi.mock("@/lib/events", () => ({ default: { emit: vi.fn() } }))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import useEditableTarget from "@/components/drivePreview/useEditableTarget"
import useSocketStore from "@/stores/useSocket.store"

// A file of the user's own drive carries its lineage's stable id; one listed through a public link or a share
// does not.
function galleryItem(uuid: string, parent: string, name = "notes.md", stableUuid: string | undefined = "lineage"): never {
	return { type: "drive", data: { type: "file", data: { uuid, parent, stableUuid, decryptedMeta: { name } } } } as never
}

beforeEach(() => {
	cacheState.files.clear()
	cacheState.dirs.clear()
	cacheState.linkedDirs.clear()
	vi.clearAllMocks()
	useSocketStore.setState({ state: "connected", connectedAt: 1 })
})

describe("useEditableTarget", () => {
	it("caches an open file it finds uncached, so the socket's rename and move reach it", () => {
		cacheState.dirs.set("dir", { uuid: "dir" })

		renderHook(() => useEditableTarget(galleryItem("v1", "dir")))

		expect(cacheState.files.has("v1")).toBe(true)
	})

	it("follows a move elsewhere: a parent warmed for the old directory no longer applies", async () => {
		getDirOptional.mockImplementation(uuid => Promise.resolve({ uuid }))

		const hook = renderHook(({ item }: { item: never }) => useEditableTarget(item), {
			initialProps: { item: galleryItem("v1", "search-dir") }
		})

		await waitFor(() => {
			expect(hook.result.current.parent).toEqual({ tag: "Normal", inner: [{ uuid: "search-dir" }] })
		})

		cacheState.dirs.set("moved-to", { uuid: "moved-to" })

		act(() => {
			hook.rerender({ item: galleryItem("v1", "moved-to") })
		})

		expect(hook.result.current.parent).toEqual({ tag: "Normal", inner: [{ uuid: "moved-to" }] })
		expect(hook.result.current.readOnly).toBe(false)
	})

	it("writes back to the gallery's item once it shows the saved version, renamed or moved since", () => {
		cacheState.dirs.set("dir", { uuid: "dir" })
		cacheState.dirs.set("moved-to", { uuid: "moved-to" })

		const hook = renderHook(({ item }: { item: never }) => useEditableTarget(item), {
			initialProps: { item: galleryItem("v1", "dir") }
		})
		const saved = (galleryItem("v2", "dir") as { data: unknown }).data as never

		act(() => {
			hook.result.current.applySaved(saved)
		})

		// Until the gallery swaps its item, the saved version.
		expect(hook.result.current.itemToUse?.data.uuid).toBe("v2")

		act(() => {
			hook.rerender({ item: galleryItem("v2", "moved-to") })
		})

		expect((hook.result.current.itemToUse?.data as { parent?: string } | undefined)?.parent).toBe("moved-to")
	})

	it("stays writable while the file's directory is looked up, so unsaved edits stay guarded", () => {
		getDirOptional.mockReturnValue(new Promise(() => undefined))

		const hook = renderHook(() => useEditableTarget(galleryItem("v1", "unlisted")))

		expect(hook.result.current.parent).toBeNull()
		expect(hook.result.current.readOnly).toBe(false)
	})

	it("a save resolves a directory the warm could not, and a socket reconnect warms it again", async () => {
		getDirOptional.mockRejectedValueOnce(new Error("offline"))

		const hook = renderHook(() => useEditableTarget(galleryItem("v1", "unlisted")))

		await waitFor(() => {
			expect(getDirOptional).toHaveBeenCalledTimes(1)
		})

		getDirOptional.mockImplementation(uuid => Promise.resolve({ uuid }))

		let resolved: unknown = null

		await act(async () => {
			resolved = await hook.result.current.resolveParent()
		})

		expect(resolved).toEqual({ tag: "Normal", inner: [{ uuid: "unlisted" }] })

		cacheState.dirs.delete("unlisted")
		getDirOptional.mockClear()

		act(() => {
			useSocketStore.getState().setState("disconnected")
			useSocketStore.getState().setState("connected")
		})

		await waitFor(() => {
			expect(getDirOptional).toHaveBeenCalledWith("unlisted", expect.anything())
		})
	})

	it("a file listed through a public link or a share stays read-only, and its parent is never looked up", async () => {
		cacheState.linkedDirs.set("link-dir", {})

		const linked = renderHook(() => useEditableTarget(galleryItem("l1", "link-dir", "notes.md", undefined)))
		const linkedCachedParent = renderHook(() => useEditableTarget(galleryItem("l2", "link-dir")))

		expect(linked.result.current.readOnly).toBe(true)
		expect(linkedCachedParent.result.current.readOnly).toBe(true)
		await expect(linked.result.current.resolveParent()).resolves.toBeNull()

		act(() => {
			useSocketStore.getState().setState("disconnected")
			useSocketStore.getState().setState("connected")
		})

		expect(getDirOptional).not.toHaveBeenCalled()
		expect(cacheState.files.has("l1")).toBe(false)
	})
})
