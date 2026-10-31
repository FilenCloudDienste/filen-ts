import { describe, expect, it } from "vitest"
import { refusal } from "../../scripts/ci/e2e/context.ts"
import { plan, previousVersion, type PlanInput } from "../../scripts/ci/e2ePlan.ts"

const dispatch: PlanInput = {
	platforms: "windows,mac,linux",
	profile: "custom",
	eventName: "workflow_dispatch",
	signed: false,
	scenarios: "previous,legacy",
	legacy: true,
	formats: "",
	spike: "none"
}

const ids = (input: PlanInput) => plan(input).tests.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)

describe("e2ePlan", () => {
	it("keeps N-1 below N for every version shape", () => {
		expect(previousVersion("4.0.1")).toBe("4.0.0")
		expect(previousVersion("4.1.0")).toBe("4.0.999")
		expect(previousVersion("4.0.0")).toBe("3.999.999")
		expect(previousVersion("4.0.0-alpha.0")).toBe("3.999.999")
		expect(() => previousVersion("0.0.0")).toThrow()
	})

	it("leaves macOS out of unsigned update runs and signs nothing", () => {
		const result = plan(dispatch)

		expect(result.builds.map(entry => entry.os)).toEqual(["windows", "linux"])
		expect(result.builds.every(entry => !entry.sign)).toBe(true)
		expect(result.tests).toHaveLength(8)
		expect(result.tests.every(entry => entry.previous && entry.legacy && !entry.signed && entry.spike === "")).toBe(true)
		expect(result.notices).toHaveLength(1)
	})

	it("tests every entry signed at release", () => {
		const result = plan({ ...dispatch, profile: "release", eventName: "push", signed: true })

		expect(result.tests).toHaveLength(10)
		expect(result.builds.every(entry => entry.sign)).toBe(true)
	})

	it("runs every entry at night with macOS signed and Windows unsigned", () => {
		const result = plan({ ...dispatch, platforms: "", profile: "", eventName: "schedule", signed: true, scenarios: "", spike: "" })

		expect(result.profile).toBe("nightly")
		expect(result.tests).toHaveLength(10)
		expect(Object.fromEntries(result.builds.map(entry => [entry.os, entry.sign]))).toEqual({ windows: false, mac: true, linux: false })
		expect(result.tests.every(entry => entry.previous && entry.legacy)).toBe(true)
	})

	it("narrows scenarios and formats, and validates both", () => {
		expect(ids({ ...dispatch, formats: "win-x64-nsis,linux-x64-deb" })).toEqual(["win-x64-nsis", "linux-x64-deb"])
		expect(plan({ ...dispatch, scenarios: "previous" }).tests.every(entry => entry.previous && !entry.legacy)).toBe(true)
		expect(plan({ ...dispatch, legacy: false }).tests.every(entry => !entry.legacy)).toBe(true)
		expect(() => plan({ ...dispatch, formats: "win-x64-dmg" })).toThrow()
		expect(() => plan({ ...dispatch, profile: "nightly", formats: "win-x64-nsis" })).toThrow()
		expect(() => plan({ ...dispatch, scenarios: "previous,$(id)" })).toThrow()
		expect(() => plan({ ...dispatch, platforms: "beos" })).toThrow()
		expect(() => plan({ ...dispatch, scenarios: "legacy", legacy: false })).toThrow()
	})

	it("plans spikes on one entry per OS, without the update scenarios", () => {
		const s1 = plan({ ...dispatch, profile: "nightly", spike: "s1" })

		expect(s1.tests.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)).toEqual([
			"win-x64-nsis",
			"mac-arm64-dmg",
			"linux-x64-deb"
		])
		expect(s1.tests.every(entry => entry.spike === "s1" && !entry.previous && !entry.legacy)).toBe(true)
		expect(ids({ ...dispatch, spike: "s1" })).toEqual(["win-x64-nsis", "linux-x64-deb"])
		expect(() => plan({ ...dispatch, spike: "s7" })).toThrow()
		expect(ids({ ...dispatch, profile: "nightly", spike: "s7" })).toEqual(["mac-arm64-dmg"])
		expect(plan({ ...dispatch, signed: true, spike: "s7" }).builds).toEqual([{ os: "mac", runner: "macos-26", sign: true }])
	})
})

describe("disposable-machine guard", () => {
	it("runs on GitHub Actions, and elsewhere only on a marked machine without Filen", () => {
		expect(refusal({ githubActions: true, disposable: false, existing: ["/x"] })).toBeNull()
		expect(refusal({ githubActions: false, disposable: false, existing: [] })).toMatch(/outside GitHub Actions/)
		expect(refusal({ githubActions: false, disposable: true, existing: ["/Users/me/Library/Application Support/@filen"] })).toMatch(
			/has Filen data/
		)
		expect(refusal({ githubActions: false, disposable: true, existing: [] })).toBeNull()
	})
})
