import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

const h = vi.hoisted(() => ({
	items: new Map<string, unknown>(),
	dirs: new Map<string, unknown>(),
	cache: { rootUuid: "root" as string | null }
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("@filen/sdk-rs", () => ({ AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" } }))
vi.mock("@/constants", () => ({ EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set(), EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set() }))
vi.mock("@/lib/serializer", () => ({ serialize: (x: unknown) => JSON.stringify(x) }))
// Fixtures carry their parent uuid as a plain string.
vi.mock("@/lib/sdkUnwrap", () => ({ unwrapParentUuid: (parent: string | null) => parent }))
vi.mock("@/lib/cache", () => ({
	default: {
		get rootUuid() {
			return h.cache.rootUuid
		},
		uuidToAnyDriveItem: h.items,
		directoryUuidToAnyNormalDir: h.dirs
	}
}))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn(async (fn: () => Promise<unknown>) => {
		try {
			return { success: true, data: await fn() }
		} catch (error) {
			return { success: false, error }
		}
	})
}))
vi.mock("@/features/drive/drive", () => ({ default: { move: vi.fn() } }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn(() => "job-1") } }))

import { ancestryHits, canPasteInto, copyDestinationOf } from "@/features/drive/clipboard"
import { buildPasteHereMenuButtons, buildPasteIntoMenuButton, pasteClipboard } from "@/features/drive/components/clipboardMenu"
import useDriveClipboardStore, { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import copyRunner from "@/features/copy/copyRunner"
import alerts from "@/lib/alerts"
import events from "@/lib/events"
import type { AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

const t = ((key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`)) as unknown as TFunction

function dir(uuid: string, parent: string | null): DriveItem {
	return { type: "directory", data: { uuid, parent, decryptedMeta: { name: `name-${uuid}` } } } as unknown as DriveItem
}

function file(uuid: string, parent: string | null): DriveItem {
	return { type: "file", data: { uuid, parent, decryptedMeta: { name: `name-${uuid}` } } } as unknown as DriveItem
}

function normalDir(uuid: string, tag: "Dir" | "Root" = "Dir"): AnyNormalDir {
	return { tag, inner: [{ uuid }] } as unknown as AnyNormalDir
}

// An own directory as the cache holds it: the SDK Dir under its parent.
function ownDir(uuid: string, parent: string | null): void {
	h.dirs.set(uuid, { tag: "Dir", inner: [{ uuid, parent }] })
	h.items.set(uuid, dir(uuid, parent))
}

// root ─ a ─ b ─ c
function seedTree(): void {
	ownDir("a", "root")
	ownDir("b", "a")
	ownDir("c", "b")
}

beforeEach(() => {
	vi.clearAllMocks()
	h.items.clear()
	h.dirs.clear()
	h.cache.rootUuid = "root"
	useDriveClipboardStore.getState().clear()
	seedTree()
})

describe("ancestryHits", () => {
	it("finds the target itself and every ancestor, but not siblings", () => {
		expect(ancestryHits("c", new Set(["c"]), "root")).toBe(true)
		expect(ancestryHits("c", new Set(["a"]), "root")).toBe(true)
		expect(ancestryHits("a", new Set(["c"]), "root")).toBe(false)
		expect(ancestryHits("root", new Set(["a"]), "root")).toBe(false)
	})

	it("is unresolved when a link is missing or the chain never ends", () => {
		expect(ancestryHits("x", new Set(["a"]), "root")).toBe("unresolved")

		ownDir("loop1", "loop2")
		ownDir("loop2", "loop1")

		expect(ancestryHits("loop1", new Set(["a"]), "root")).toBe("unresolved")
	})

	it("walks through a shared-out directory, which the uuid→item map holds as its shared variant", () => {
		// A shared-out listing overwrites the own directory's item entry; the own-directory map keeps the Dir.
		h.items.set("b", { type: "sharedRootDirectory", data: { uuid: "b" } })

		expect(ancestryHits("c", new Set(["x"]), "root")).toBe(false)
		expect(ancestryHits("c", new Set(["a"]), "root")).toBe(true)
		expect(canPasteInto({ entry: { mode: "copy", items: [dir("x", "root")] }, targetUuid: "c", allowCut: true })).toBe(true)
	})
})

describe("canPasteInto", () => {
	const copyOf = (items: DriveItem[]): DriveClipboardEntry => ({ mode: "copy", items })
	const cutOf = (items: DriveItem[]): DriveClipboardEntry => ({ mode: "cut", items })

	it("refuses an empty clipboard", () => {
		expect(canPasteInto({ entry: null, targetUuid: "a", allowCut: true })).toBe(false)
		expect(canPasteInto({ entry: copyOf([]), targetUuid: "a", allowCut: true })).toBe(false)
	})

	it("refuses a directory into itself or below it, allows it elsewhere and beside itself", () => {
		const entry = copyOf([h.items.get("a") as DriveItem])

		expect(canPasteInto({ entry, targetUuid: "a", allowCut: true })).toBe(false)
		expect(canPasteInto({ entry, targetUuid: "c", allowCut: true })).toBe(false)
		expect(canPasteInto({ entry, targetUuid: null, allowCut: true })).toBe(true)
		expect(canPasteInto({ entry, targetUuid: "root", allowCut: true })).toBe(true)
	})

	it("refuses directories into an unresolved chain but lets files through", () => {
		expect(canPasteInto({ entry: copyOf([h.items.get("a") as DriveItem]), targetUuid: "unknown", allowCut: true })).toBe(false)
		expect(canPasteInto({ entry: copyOf([file("f", "a")]), targetUuid: "unknown", allowCut: true })).toBe(true)
	})

	it("offers a cut only where it may move, and never where every item already is", () => {
		const items = [file("f1", "a"), file("f2", "a")]

		expect(canPasteInto({ entry: cutOf(items), targetUuid: "b", allowCut: false })).toBe(false)
		expect(canPasteInto({ entry: cutOf(items), targetUuid: "a", allowCut: true })).toBe(false)
		expect(canPasteInto({ entry: cutOf([...items, file("f3", "b")]), targetUuid: "a", allowCut: true })).toBe(true)
		expect(canPasteInto({ entry: cutOf(items), targetUuid: "b", allowCut: true })).toBe(true)
		// The root may be addressed by null or by its uuid.
		expect(canPasteInto({ entry: cutOf([file("r", "root")]), targetUuid: null, allowCut: true })).toBe(false)
	})

	it("derives the guard once per clipboard entry, not per row render", () => {
		let indexReads = 0
		const items = new Proxy([file("f1", "a"), dir("d1", "a"), file("f2", "a")], {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) {
					indexReads++
				}

				return Reflect.get(target, key, receiver)
			}
		})
		const entry: DriveClipboardEntry = { mode: "cut", items }

		for (let i = 0; i < 100; i++) {
			canPasteInto({ entry, targetUuid: "b", allowCut: true })
		}

		expect(indexReads).toBe(3)
	})

	it("lets a copy land beside its source", () => {
		expect(canPasteInto({ entry: copyOf([file("f1", "a")]), targetUuid: "a", allowCut: false })).toBe(true)
	})
})

describe("copyDestinationOf", () => {
	it("names the root and cached directories", () => {
		expect(copyDestinationOf(normalDir("root", "Root"), "root", "Drive")).toEqual({ uuid: null, name: "Drive" })
		expect(copyDestinationOf(normalDir("root"), "root", "Drive")).toEqual({ uuid: null, name: "Drive" })
		expect(copyDestinationOf(normalDir("b"), "root", "Drive")).toEqual({ uuid: "b", name: "name-b" })
		expect(copyDestinationOf(normalDir("zz"), "root", "Drive")).toEqual({ uuid: "zz", name: "zz" })
	})
})

describe("pasteClipboard", () => {
	it("copy: starts ONE job for every item and keeps the clipboard", async () => {
		const items = [file("f1", "a"), file("f2", "a")]

		useDriveClipboardStore.getState().set({ mode: "copy", items })

		await pasteClipboard({ targetDir: normalDir("b"), allowCut: false, t })
		await pasteClipboard({ targetDir: normalDir("c"), allowCut: false, t })

		expect(copyRunner.start).toHaveBeenCalledTimes(2)
		expect(copyRunner.start).toHaveBeenCalledWith({ items, destination: { uuid: "b", name: "name-b" }, destinationDir: normalDir("b") })
		expect(runWithLoading).not.toHaveBeenCalled()
		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items })
	})

	it("cut: moves each item behind the loader and clears the clipboard", async () => {
		const items = [file("f1", "a"), dir("d1", "a")]

		useDriveClipboardStore.getState().set({ mode: "cut", items })

		await pasteClipboard({ targetDir: normalDir("b"), allowCut: true, t })

		expect(runWithLoading).toHaveBeenCalledTimes(1)
		expect(drive.move).toHaveBeenCalledTimes(2)
		expect(drive.move).toHaveBeenCalledWith({ item: items[0], newParent: normalDir("b") })
		expect(copyRunner.start).not.toHaveBeenCalled()
		expect(useDriveClipboardStore.getState().entry).toBeNull()
		expect(alerts.error).not.toHaveBeenCalled()
	})

	it("cut: puts back only what failed to move and alerts", async () => {
		const items = [file("f1", "a"), file("f2", "a"), file("f3", "a")]
		const error = new Error("move failed")

		vi.mocked(drive.move).mockImplementation(async ({ item }) => {
			if (item.data.uuid === "f2") {
				throw error
			}

			return item as Awaited<ReturnType<typeof drive.move>>
		})

		useDriveClipboardStore.getState().set({ mode: "cut", items })

		await pasteClipboard({ targetDir: normalDir("b"), allowCut: true, t })

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "cut", items: [items[1]] })
		expect(useDriveClipboardStore.getState().cutUuids).toEqual(new Set(["f2"]))
		expect(alerts.error).toHaveBeenCalledWith(error)

		vi.mocked(drive.move).mockReset()
	})

	it("cut: moves each item as it is now, after a rename or content save since the cut", async () => {
		const cut = file("f1", "a")
		const saved = { type: "file", data: { uuid: "f2", parent: "a", decryptedMeta: { name: "renamed" } } } as unknown as DriveItem

		useDriveClipboardStore.getState().set({ mode: "cut", items: [cut] })
		events.emit("driveItemUpdated", { previousUuid: "f1", item: saved })

		expect(useDriveClipboardStore.getState().cutUuids).toEqual(new Set(["f2"]))

		await pasteClipboard({ targetDir: normalDir("b"), allowCut: true, t })

		expect(drive.move).toHaveBeenCalledExactlyOnceWith({ item: saved, newParent: normalDir("b") })
	})

	it("cut: what fails comes back as it is by then, and an item trashed meanwhile doesn't", async () => {
		const items = [file("f1", "a"), file("f2", "a"), file("f3", "a")]
		const renamed = { type: "file", data: { uuid: "f1", parent: "a", decryptedMeta: { name: "renamed" } } } as unknown as DriveItem

		vi.mocked(drive.move).mockImplementation(async ({ item }) => {
			if (item.data.uuid === "f1") {
				events.emit("driveItemUpdated", { previousUuid: "f1", item: renamed })
			}

			if (item.data.uuid === "f2") {
				events.emit("driveItemRemoved", { uuid: "f2" })
			}

			throw new Error("move failed")
		})

		useDriveClipboardStore.getState().set({ mode: "cut", items })

		await pasteClipboard({ targetDir: normalDir("b"), allowCut: true, t })

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "cut", items: [renamed, items[2]] })

		vi.mocked(drive.move).mockReset()
	})

	it("re-checks the guard against the current clipboard", async () => {
		useDriveClipboardStore.getState().set({ mode: "cut", items: [dir("a", "root")] })

		await pasteClipboard({ targetDir: normalDir("c"), allowCut: true, t })

		expect(drive.move).not.toHaveBeenCalled()
		expect(useDriveClipboardStore.getState().entry).not.toBeNull()
	})
})

describe("paste menu buttons", () => {
	it("offers nothing while the clipboard is empty", () => {
		expect(buildPasteHereMenuButtons({ entry: null, targetDir: normalDir("b"), allowCut: true, t })).toEqual([])
		expect(buildPasteIntoMenuButton({ entry: null, targetDir: normalDir("b"), allowCut: true, t })).toBeNull()
	})

	it("titles Paste by count, gates only Paste on the network, and Clear empties the clipboard", () => {
		const one = buildPasteHereMenuButtons({ entry: { mode: "copy", items: [file("f1", "a")] }, targetDir: normalDir("b"), allowCut: true, t })
		const three = buildPasteHereMenuButtons({
			entry: { mode: "copy", items: [file("f1", "a"), file("f2", "a"), file("f3", "a")] },
			targetDir: normalDir("b"),
			allowCut: true,
			t
		})

		expect(one.map(button => [button.id, button.title, button.requiresOnline === true, button.disabled])).toEqual([
			["paste", "paste", true, false],
			["clearClipboard", "clear_clipboard", false, undefined]
		])
		expect(three[0]?.title).toBe("paste_items:3")

		useDriveClipboardStore.getState().set({ mode: "copy", items: [file("f1", "a")] })
		one[1]?.onPress?.()

		expect(useDriveClipboardStore.getState().entry).toBeNull()
	})

	it("disables Paste here where it can't land, and hides Paste into there", () => {
		const entry: DriveClipboardEntry = { mode: "copy", items: [dir("a", "root")] }

		expect(buildPasteHereMenuButtons({ entry, targetDir: normalDir("c"), allowCut: true, t })[0]?.disabled).toBe(true)
		expect(buildPasteHereMenuButtons({ entry, targetDir: null, allowCut: true, t })[0]?.disabled).toBe(true)
		expect(buildPasteIntoMenuButton({ entry, targetDir: normalDir("c"), allowCut: true, t })).toBeNull()
		expect(buildPasteIntoMenuButton({ entry, targetDir: undefined, allowCut: true, t })).toBeNull()
		expect(buildPasteIntoMenuButton({ entry, targetDir: normalDir("x-sibling"), allowCut: true, t })).toBeNull()

		ownDir("sib", "root")

		expect(buildPasteIntoMenuButton({ entry, targetDir: normalDir("sib"), allowCut: true, t })?.id).toBe("pasteInto")
	})
})
