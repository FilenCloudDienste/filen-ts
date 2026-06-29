import { vi, describe, it, expect } from "vitest"

// driveViewModePreference.ts uses useSecureStore (react hook), but we only test the
// pure exported helpers here — no hook rendering is needed.

vi.mock("@/lib/secureStore", () => ({
	useSecureStore: vi.fn()
}))

import { resolveEffectiveViewMode, DEFAULT_VIEW_MODE_PREFERENCES, type ViewModePreferences } from "@/features/drive/driveViewModePreference"
import { type DrivePath } from "@/hooks/useDrivePath"

const path = (type: DrivePath["type"], uuid: string | null = null): DrivePath => ({ type, uuid }) as DrivePath

describe("resolveEffectiveViewMode", () => {
	it("global mode returns the global value regardless of directory", () => {
		const prefs: ViewModePreferences = { mode: "global", global: "grid", perDirectory: { "drive:abc": "list" } }
		expect(resolveEffectiveViewMode(prefs, path("drive", "abc"))).toBe("grid")
	})

	it("perDirectory mode returns the per-directory value when present", () => {
		const prefs: ViewModePreferences = { mode: "perDirectory", global: "list", perDirectory: { "drive:abc": "grid" } }
		expect(resolveEffectiveViewMode(prefs, path("drive", "abc"))).toBe("grid")
	})

	it("perDirectory mode falls back to the global value when the directory has no override", () => {
		const prefs: ViewModePreferences = { mode: "perDirectory", global: "grid", perDirectory: {} }
		expect(resolveEffectiveViewMode(prefs, path("drive", "xyz"))).toBe("grid")
	})

	it("default preferences resolve to list", () => {
		expect(resolveEffectiveViewMode(DEFAULT_VIEW_MODE_PREFERENCES, path("drive", null))).toBe("list")
	})
})
