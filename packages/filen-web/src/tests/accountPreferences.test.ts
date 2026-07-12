import { describe, expect, it, vi } from "vitest"
import {
	runPreferenceToggle,
	isPreferenceRowDisabled,
	type PreferenceToggleDeps
} from "@/features/settings/components/account/accountPreferences.logic"

function makeHarness() {
	const setEnabled = vi.fn<(enabled: boolean) => Promise<void>>()
	const refetch = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
	const deps: PreferenceToggleDeps = { setEnabled, refetch }
	return { deps, setEnabled, refetch }
}

// Covers BOTH toggles (versioning + login alerts share this exact round-trip shape — see
// accountPreferencesCard.tsx) since the injected-deps harness is toggle-agnostic.
describe("runPreferenceToggle (injected deps, no worker — mocks the SDK op per the settings study's e2e safety classes)", () => {
	it("calls setEnabled with the requested value, then refetches on success", async () => {
		const h = makeHarness()
		h.setEnabled.mockResolvedValue(undefined)

		await expect(runPreferenceToggle(h.deps, true)).resolves.toEqual({ status: "success" })

		expect(h.setEnabled).toHaveBeenCalledOnce()
		expect(h.setEnabled).toHaveBeenCalledWith(true)
		expect(h.refetch).toHaveBeenCalledTimes(1)
	})

	it("round-trips the OFF direction too", async () => {
		const h = makeHarness()
		h.setEnabled.mockResolvedValue(undefined)

		await expect(runPreferenceToggle(h.deps, false)).resolves.toEqual({ status: "success" })

		expect(h.setEnabled).toHaveBeenCalledWith(false)
	})

	it("a setEnabled failure never refetches — the switch is left reading whatever the last successful fetch resolved to", async () => {
		const h = makeHarness()
		const error = { species: "sdk" as const, kind: "Unknown", message: "boom", label: "boom" }
		h.setEnabled.mockRejectedValue(error)

		const outcome = await runPreferenceToggle(h.deps, true)

		expect(outcome).toEqual({ status: "error", dto: error })
		expect(h.refetch).not.toHaveBeenCalled()
	})
})

describe("isPreferenceRowDisabled", () => {
	it("disables the row while offline, even with no toggle in flight", () => {
		expect(isPreferenceRowDisabled(false, false)).toBe(true)
	})

	it("disables the row while a toggle is in flight, even online", () => {
		expect(isPreferenceRowDisabled(true, true)).toBe(true)
	})

	it("leaves the row enabled only when online and idle", () => {
		expect(isPreferenceRowDisabled(false, true)).toBe(false)
	})
})
