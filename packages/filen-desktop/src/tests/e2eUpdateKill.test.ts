import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { plan, type PlanInput } from "../../scripts/ci/e2ePlan.ts"

const dispatch: PlanInput = {
	platforms: "windows,mac,linux",
	profile: "custom",
	eventName: "workflow_dispatch",
	signed: true,
	scenarios: "previous,legacy",
	legacy: true,
	formats: "",
	depth: "",
	spike: "none",
	signin: "",
	day: 0
}

const killed = (input: PlanInput) =>
	plan(input)
		.tests.filter(entry => entry.updateKill)
		.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)

describe("e2ePlan update-kill", () => {
	it("runs in every release run on every entry but rpm", () => {
		expect(killed({ ...dispatch, profile: "release", eventName: "workflow_call" })).toEqual([
			"win-x64-nsis",
			"win-arm64-nsis",
			"mac-arm64-dmg",
			"mac-x64-dmg",
			"linux-x64-deb",
			"linux-x64-AppImage",
			"linux-arm64-deb",
			"linux-arm64-AppImage"
		])
	})

	it("never runs at night, and by hand only when named", () => {
		expect(killed({ ...dispatch, platforms: "", profile: "", eventName: "schedule", scenarios: "", spike: "" })).toEqual([])
		expect(killed(dispatch)).toEqual([])
		expect(killed({ ...dispatch, scenarios: "previous,update-kill", formats: "win-x64-nsis,linux-x64-rpm" })).toEqual(["win-x64-nsis"])
		expect(killed({ ...dispatch, spike: "s1" })).toEqual([])
	})

	it("alone, plans only the entries it runs on, without the update scenarios", () => {
		const result = plan({ ...dispatch, scenarios: "update-kill", formats: "linux-x64-deb,linux-x64-rpm" })

		expect(result.tests.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)).toEqual(["linux-x64-deb"])
		expect(result.tests.every(entry => entry.updateKill && !entry.previous && !entry.legacy && !entry.deep)).toBe(true)
		expect(result.session).toBe(false)
		expect(() => plan({ ...dispatch, scenarios: "update-kill", formats: "linux-x64-rpm" })).toThrow("nothing to test")
		expect(() => plan({ ...dispatch, scenarios: "update-kill,kill" })).toThrow()
	})

	it("with 3.0.47 and no update scenario, plans the entries either runs on", () => {
		const result = plan({ ...dispatch, scenarios: "older,update-kill", formats: "win-x64-nsis,linux-x64-rpm,linux-x64-AppImage" })
		const ids = (pick: (entry: (typeof result.tests)[number]) => boolean) =>
			result.tests.filter(pick).map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)

		expect(ids(() => true)).toEqual(["win-x64-nsis", "linux-x64-AppImage"])
		expect(ids(entry => entry.older)).toEqual(["win-x64-nsis"])
		expect(ids(entry => entry.updateKill)).toEqual(["win-x64-nsis", "linux-x64-AppImage"])
	})

	it("is a workflow step of its own, install depth, with no account secrets", () => {
		const text = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/desktop-e2e.yml", import.meta.url)), "utf8")
		const step = /- name: N-1 -> N, installer killed\n([\s\S]*?)\n\s+- name:/.exec(text)?.[1] ?? ""

		expect(step).toContain("if: ${{ !cancelled() && matrix.updateKill }}")
		expect(step).toContain("run: node scripts/ci/e2e.ts --scenario update-kill ${{ env.TEST_ARGS }}")
		expect(step).toMatch(/timeout-minutes: \d+/)
		expect(step).not.toContain("secrets.")
	})
})
