import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@filen/sdk-rs", () => ({
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
		directoryUuidToAnyNormalDir: new Map<string, unknown>()
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

import { getDriveParent, canShowDriveCreateMenu } from "@/features/drive/components/driveCreateMenu"
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
