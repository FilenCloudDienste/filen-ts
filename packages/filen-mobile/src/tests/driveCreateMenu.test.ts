import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// This suite exercises only getDriveParent / canShowDriveCreateMenu, neither of which touches the
// hidden-items preference — but driveCreateMenu imports components/hiddenNameNotice, which reaches
// driveHiddenItems -> secureStore -> expo-secure-store. The stub exists purely to keep the module
// graph loadable. isHiddenName now comes from @filen/shared (see filenShared mock).
vi.mock("@/features/drive/driveHiddenItems", () => ({
	readHideHiddenItems: async () => false
}))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))

vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn() } }))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
	AnyNormalDir: {
		Root: class {
			tag = "Root"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		},
		Dir: class {
			tag = "Dir"
			inner: unknown[]
			constructor(v: unknown) {
				this.inner = [v]
			}
		}
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		rootUuid: null as string | null,
		directoryUuidToAnyNormalDir: new Map<string, unknown>(),
		uuidToAnyDriveItem: new Map<string, unknown>()
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: vi.fn(),
		normal: vi.fn()
	}
}))

vi.mock("@/lib/prompts", () => ({
	default: {
		alert: vi.fn(),
		input: vi.fn()
	}
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn(fn => fn()) }))

vi.mock("@/features/drive/drive", () => ({
	default: {
		createDirectory: vi.fn()
	}
}))

import { getDriveParent, canShowDriveCreateMenu, buildDriveCreateMenuButtons } from "@/features/drive/components/driveCreateMenu"
import type { UseDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import type { DriveItem } from "@/types"
import type { TFunction } from "i18next"
import cache from "@/lib/cache"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { AnyNormalDir } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT_UUID = "11111111-1111-4111-8111-111111111111"
const DIR_UUID = "22222222-2222-4222-8222-222222222222"

const drivePathAt = (uuid: string | null): DrivePath => ({ type: "drive", uuid })

beforeEach(() => {
	cache.rootUuid = null
	cache.directoryUuidToAnyNormalDir.clear()
})

// ---------------------------------------------------------------------------
// getDriveParent — root resolution
// ---------------------------------------------------------------------------

describe("getDriveParent", () => {
	// The index redirect / start-screen href mounts the drive tab at
	// /tabs/drive/<rootUuid>, so at the root the route param IS the root uuid.
	// The root directory is never present in directoryUuidToAnyNormalDir, so this
	// case must short-circuit to AnyNormalDir.Root like the listing query does.
	it("resolves the root parent when the route carries the explicit root uuid", () => {
		cache.rootUuid = ROOT_UUID

		const parent = getDriveParent(drivePathAt(ROOT_UUID)) as { tag: string; inner: { uuid: string }[] } | null

		expect(parent?.tag).toBe("Root")
		expect(parent?.inner[0]?.uuid).toBe(ROOT_UUID)
	})

	it("resolves the root parent when the route has no uuid (native-tab nav)", () => {
		cache.rootUuid = ROOT_UUID

		const parent = getDriveParent(drivePathAt(null)) as { tag: string; inner: { uuid: string }[] } | null

		expect(parent?.tag).toBe("Root")
		expect(parent?.inner[0]?.uuid).toBe(ROOT_UUID)
	})

	it("returns the cached directory for a non-root uuid", () => {
		cache.rootUuid = ROOT_UUID

		const cachedDir = { tag: "Dir" } as unknown as AnyNormalDir

		cache.directoryUuidToAnyNormalDir.set(DIR_UUID, cachedDir)

		expect(getDriveParent(drivePathAt(DIR_UUID))).toBe(cachedDir)
	})

	it("returns null for an uncached non-root uuid", () => {
		cache.rootUuid = ROOT_UUID

		expect(getDriveParent(drivePathAt(DIR_UUID))).toBeNull()
	})

	it("returns null at the root when the root uuid is not cached yet", () => {
		expect(getDriveParent(drivePathAt(null))).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// canShowDriveCreateMenu — the header menu / empty-state CTA gate at the root
// ---------------------------------------------------------------------------

describe("canShowDriveCreateMenu", () => {
	it("shows the create menu at the drive root mounted with the explicit root uuid", () => {
		cache.rootUuid = ROOT_UUID

		const drivePath = drivePathAt(ROOT_UUID)
		const parent = getDriveParent(drivePath)

		expect(
			canShowDriveCreateMenu({
				drivePath,
				parent,
				selectionMode: false
			})
		).toBe(true)
	})

	it("hides the create menu while items are selected", () => {
		cache.rootUuid = ROOT_UUID

		const drivePath = drivePathAt(ROOT_UUID)
		const parent = getDriveParent(drivePath)

		expect(
			canShowDriveCreateMenu({
				drivePath,
				parent,
				selectionMode: true
			})
		).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// buildDriveCreateMenuButtons — Paste + Clear clipboard (header and empty-state Add menu)
// ---------------------------------------------------------------------------

describe("buildDriveCreateMenuButtons clipboard entries", () => {
	const t = ((key: string) => key) as unknown as TFunction
	const upload = {} as UseDriveUpload
	const files = [{ type: "file", data: { uuid: "f1", parent: DIR_UUID } } as unknown as DriveItem]

	function ids(drivePath: DrivePath, clipboard: Parameters<typeof buildDriveCreateMenuButtons>[0]["clipboard"]) {
		cache.rootUuid = ROOT_UUID

		return buildDriveCreateMenuButtons({ t, parent: getDriveParent(drivePath), upload, drivePath, clipboard }).map(button => [
			button.id,
			button.disabled === true
		])
	}

	it("adds nothing while the clipboard is empty", () => {
		expect(ids(drivePathAt(null), null)).toEqual([
			["createFolder", false],
			["upload", false]
		])
	})

	it("adds Paste and Clear clipboard after the create actions", () => {
		expect(ids(drivePathAt(null), { mode: "copy", items: files })).toEqual([
			["createFolder", false],
			["upload", false],
			["paste", false],
			["clearClipboard", false]
		])
	})

	it("disables a cut paste outside the drive view", () => {
		const favoritesPath: DrivePath = { type: "favorites", uuid: DIR_UUID }

		cache.directoryUuidToAnyNormalDir.set(DIR_UUID, { tag: "Dir", inner: [{ uuid: "other" }] } as unknown as AnyNormalDir)

		expect(ids(favoritesPath, { mode: "cut", items: files }).find(([id]) => id === "paste")).toEqual(["paste", true])
		expect(ids(favoritesPath, { mode: "copy", items: files }).find(([id]) => id === "paste")).toEqual(["paste", false])
	})
})
