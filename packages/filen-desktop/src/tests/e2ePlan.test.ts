import { describe, expect, it } from "vitest"
import { refusal } from "../../scripts/ci/e2e/context.ts"
import { DEEP_TRIAL, plan, type Plan, type PlanInput, previousVersion } from "../../scripts/ci/e2ePlan.ts"

const dispatch: PlanInput = {
	platforms: "windows,mac,linux",
	profile: "custom",
	eventName: "workflow_dispatch",
	signed: false,
	scenarios: "previous,legacy",
	legacy: true,
	formats: "",
	depth: "",
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
		expect(result.notices.filter(notice => notice.startsWith("macOS is not tested unsigned"))).toHaveLength(1)
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

describe("e2ePlan depth", () => {
	const deep = (input: PlanInput) =>
		plan(input)
			.tests.filter(entry => entry.deep)
			.map(entry => `${entry.platform}-${entry.arch}-${entry.format}@${String(entry.stagger)}`)

	// The run's logins: the harness sign-in, then one UI sign-in per deep chain.
	const logins = (result: Plan) =>
		(result.session ? 1 : 0) + result.tests.reduce((sum, entry) => sum + Number(entry.deepPrevious) + Number(entry.deepLegacy), 0)

	it("makes the built deep entries deep, staggers them and asks for the harness sign-in", () => {
		const nightly = plan({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" })
		const windows = nightly.tests.find(entry => entry.platform === "win" && entry.arch === "x64")

		expect(deep({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" })).toEqual([
			"win-x64-nsis@0",
			"linux-x64-deb@20"
		])
		expect(nightly.session).toBe(true)
		expect([windows?.deepPrevious, windows?.deepLegacy]).toEqual([true, false])
		expect(nightly.tests.find(entry => entry.format === "deb" && entry.arch === "x64")?.deepLegacy).toBe(true)
		expect(nightly.notices.some(notice => notice.includes("win-x64-nsis legacy, mac-arm64-dmg previous, mac-arm64-dmg legacy"))).toBe(
			true
		)
		// Session, Windows 4.x, Linux 4.x and Linux 3.0.53.
		expect(logins(nightly)).toBe(4)
		expect(deep({ ...dispatch, profile: "release", signed: true })).toEqual([
			"win-x64-nsis@0",
			"linux-x64-deb@20",
			"linux-arm64-deb@40"
		])
	})

	it("runs a trial entry deep only when a custom deep run names it", () => {
		const readiness = { ready: { "linux-x64-deb": ["previous", "legacy"] as const }, trial: { "win-x64-nsis": ["previous"] as const } }
		const deepWith = (input: PlanInput) =>
			plan(input, readiness)
				.tests.filter(entry => entry.deep)
				.map(entry => `${entry.platform}-${entry.arch}-${entry.format}@${String(entry.stagger)}`)
		const named = plan({ ...dispatch, depth: "deep", formats: "win-x64-nsis,linux-x64-deb" }, readiness)
		const windows = named.tests.find(entry => entry.platform === "win")

		expect([windows?.deepPrevious, windows?.deepLegacy]).toEqual([true, false])
		expect(deepWith({ ...dispatch, depth: "deep", formats: "win-x64-nsis,linux-x64-deb" })).toEqual([
			"win-x64-nsis@0",
			"linux-x64-deb@20"
		])
		expect(deepWith({ ...dispatch, depth: "deep" })).toEqual(["linux-x64-deb@0"])
		expect(deepWith({ ...dispatch, formats: "win-x64-nsis" })).toEqual([])
		expect(deepWith({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" })).toEqual(["linux-x64-deb@0"])
		expect(DEEP_TRIAL).toEqual({ "win-x64-nsis": ["legacy"] })

		// The real tables: Windows' 3.0.53 chain is deep only when named, its N-1 -> N chain always.
		const windowsNamed = plan({ ...dispatch, depth: "deep", formats: "win-x64-nsis" }).tests.find(entry => entry.platform === "win")

		expect([windowsNamed?.deepPrevious, windowsNamed?.deepLegacy]).toEqual([true, true])
		expect(logins(plan({ ...dispatch, depth: "deep", formats: "win-x64-nsis", scenarios: "legacy" }))).toBe(2)
	})

	it("keeps install depth when asked and for spikes; legacy-only runs are deep too", () => {
		expect(plan({ ...dispatch, depth: "install" }).session).toBe(false)
		expect(deep({ ...dispatch, depth: "install" })).toEqual([])
		expect(deep({ ...dispatch, scenarios: "legacy" })).toEqual(["linux-x64-deb@0"])
		expect(deep({ ...dispatch, scenarios: "previous" })).toEqual(["win-x64-nsis@0", "linux-x64-deb@20"])
		expect(plan({ ...dispatch, scenarios: "legacy" }).tests.find(entry => entry.deep)?.previous).toBe(false)
		expect(logins(plan({ ...dispatch, scenarios: "legacy" }))).toBe(2)
		expect(deep({ ...dispatch, spike: "s1" })).toEqual([])
		expect(deep({ ...dispatch, depth: "deep", formats: "linux-arm64-deb,linux-x64-rpm" })).toEqual(["linux-arm64-deb@0"])
		expect(() => plan({ ...dispatch, depth: "deepest" })).toThrow()
	})

	it("plans the cloud self-test with no build, no app and the harness sign-in", () => {
		expect(plan({ ...dispatch, spike: "cloud" })).toEqual({
			profile: "custom",
			spike: "cloud",
			session: true,
			builds: [],
			tests: [],
			notices: []
		})
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
