import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { refusal } from "../../scripts/ci/e2e/context.ts"
import { SLOTS } from "../../scripts/ci/e2e/session.ts"
import {
	DEEP_READY,
	DEEP_TRIAL,
	JOB_MAX_MINUTES,
	jobMinutes,
	MAX_LOGINS_PER_RUN,
	plan,
	type PlanInput,
	previousVersion,
	SESSION_SLOTS,
	SETUP_MINUTES,
	STEP_MINUTES
} from "../../scripts/ci/e2ePlan.ts"

const dispatch: PlanInput = {
	platforms: "windows,mac,linux",
	profile: "custom",
	eventName: "workflow_dispatch",
	signed: false,
	scenarios: "previous,legacy",
	legacy: true,
	formats: "",
	depth: "",
	spike: "none",
	signin: "",
	day: 0
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

		// Each entry's job, and the second jobs of the entries whose chains overrun one (jobMinutes).
		expect(result.tests.filter(entry => entry.lane === "")).toHaveLength(10)
		expect(result.tests.filter(entry => entry.lane !== "")).toHaveLength(3)
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

	it("plans the offline spike as chain P at deep depth on one entry per OS, signed in once each", () => {
		const offline = plan({ ...dispatch, signed: true, spike: "offline" })

		expect(offline.tests.map(entry => [`${entry.platform}-${entry.arch}-${entry.format}`, entry.stagger])).toEqual([
			["win-x64-nsis", 0],
			["mac-arm64-dmg", 20],
			["linux-x64-deb", 40]
		])
		expect(offline.tests.every(entry => entry.spike === "offline" && entry.deep && entry.deepPrevious && !entry.deepLegacy)).toBe(true)
		expect(offline.tests.every(entry => !entry.previous && !entry.legacy)).toBe(true)
		// Both slots at worst, then 4.x on each OS through its form (the only deep entry of its OS).
		expect(offline.session).toBe(true)
		expect(offline.tests.every(entry => entry.signInPrevious === "real" && entry.signInLegacy === "")).toBe(true)
		expect(offline.logins).toBe(SESSION_SLOTS + 3)
	})
})

describe("e2ePlan depth", () => {
	const deep = (input: PlanInput) =>
		plan(input)
			.tests.filter(entry => entry.deep)
			.map(entry => `${entry.platform}-${entry.arch}-${entry.format}@${String(entry.stagger)}`)

	it("makes the built deep entries deep, staggers them and asks for the harness sign-in", () => {
		const nightly = plan({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" })
		const windows = nightly.tests.find(entry => entry.platform === "win" && entry.arch === "x64")

		const mac = nightly.tests.find(entry => entry.platform === "mac")

		expect(deep({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" })).toEqual([
			"win-x64-nsis@0",
			"win-arm64-nsis@20",
			"mac-arm64-dmg@40",
			"linux-x64-deb@60",
			"linux-x64-AppImage@80",
			"linux-arm64-deb@0",
			"linux-arm64-AppImage@0"
		])
		expect(nightly.session).toBe(true)
		expect([windows?.deepPrevious, windows?.deepLegacy]).toEqual([true, true])
		expect([mac?.deepPrevious, mac?.deepLegacy]).toEqual([true, true])
		expect(nightly.tests.find(entry => entry.format === "deb" && entry.arch === "x64")?.deepLegacy).toBe(true)
		// Both AppImages run both chains every night too.
		expect(
			nightly.tests.filter(entry => entry.format === "AppImage").map(entry => [entry.runner, entry.deepPrevious, entry.deepLegacy])
		).toEqual([
			["ubuntu-24.04", true, true],
			["ubuntu-24.04-arm", true, true]
		])
		// rpm and macOS x64 stay at install depth.
		expect(
			nightly.tests
				.filter(entry => entry.format === "rpm" || (entry.platform === "mac" && entry.arch === "x64"))
				.some(entry => entry.deep)
		).toBe(false)
		expect(nightly.tests.some(entry => entry.platform === "mac" && entry.arch === "x64")).toBe(true)
		// No rotation: every deep format every night, all of them deep.
		expect(nightly.notices.some(notice => notice.startsWith("Deep depth is not built yet"))).toBe(false)
		// Both slots at worst, then one 4.x and one 3.0.53 form sign-in per OS (the other chains are seeded), and the
		// cloud-full check's one on the quota account.
		expect(nightly.logins).toBe(SESSION_SLOTS + 6 + 1)
		expect(nightly.tests.filter(entry => entry.quota).map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)).toEqual([
			"linux-x64-deb"
		])
		// Once every trial is promoted: both chains on seven entries, still one form sign-in per OS and chain.
		expect(
			plan(
				{ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" },
				{
					ready: Object.fromEntries(
						[...new Set([...Object.keys(DEEP_READY), ...Object.keys(DEEP_TRIAL)])].map(id => [
							id,
							[...(DEEP_READY[id] ?? []), ...(DEEP_TRIAL[id] ?? [])]
						])
					),
					trial: {}
				}
			).logins
		).toBe(SESSION_SLOTS + 6 + 1)
		// The nightly macOS builds are Developer-ID signed (Squirrel.Mac needs it), Windows and Linux are not.
		expect(Object.fromEntries(nightly.builds.map(build => [build.os, build.sign]))).toEqual({ windows: false, mac: true, linux: false })
		expect(mac?.signed).toBe(true)
		// Then the second jobs (3.0.47 and chain K): the real 3.0.47 sign-in spaced after the others.
		expect(deep({ ...dispatch, profile: "release", signed: true })).toEqual([
			"win-x64-nsis@0",
			"win-arm64-nsis@20",
			"mac-arm64-dmg@40",
			"linux-x64-deb@60",
			"linux-x64-AppImage@80",
			"linux-arm64-deb@0",
			"linux-arm64-AppImage@0",
			"win-x64-nsis@100",
			"mac-arm64-dmg@0",
			"linux-x64-deb@0"
		])
		// A custom deep run without FORMATS takes the release's deep entries, with the same form sign-ins.
		expect(plan({ ...dispatch, signed: true, depth: "deep" }).logins).toBe(SESSION_SLOTS + 6 + 1)
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
		expect(DEEP_TRIAL).toEqual({})

		// The real tables: a custom deep run naming Windows arm64 runs both chains on its own runner.
		const arm = plan({ ...dispatch, platforms: "windows", depth: "deep", formats: "win-arm64-nsis" })

		expect(arm.tests.map(entry => [entry.runner, entry.deepPrevious, entry.deepLegacy])).toEqual([["windows-11-arm", true, true]])
		expect(arm.logins).toBe(SESSION_SLOTS + 2)

		// macOS chain P alone, named: one form sign-in.
		const mac = plan({ ...dispatch, platforms: "mac", signed: true, scenarios: "previous", depth: "deep", formats: "mac-arm64-dmg" })

		expect(mac.tests.map(entry => [entry.format, entry.deepPrevious, entry.deepLegacy])).toEqual([["dmg", true, false]])
		expect(mac.logins).toBe(SESSION_SLOTS + 1)

		// An AppImage named in a custom deep run: both chains.
		const appImage = plan({ ...dispatch, platforms: "linux", depth: "deep", formats: "linux-arm64-AppImage" })

		expect(appImage.tests.map(entry => [entry.runner, entry.deepPrevious, entry.deepLegacy])).toEqual([
			["ubuntu-24.04-arm", true, true]
		])
	})

	it("runs a trial entry outside the deep formats when a custom deep run names it", () => {
		const readiness = { ready: DEEP_READY, trial: { "linux-x64-rpm": ["previous"] as const } }
		const deepWith = (input: PlanInput) =>
			plan(input, readiness)
				.tests.filter(entry => entry.deep)
				.map(entry => `${entry.platform}-${entry.arch}-${entry.format}:${String(entry.deepPrevious)}:${String(entry.deepLegacy)}`)

		expect(deepWith({ ...dispatch, platforms: "linux", depth: "deep", formats: "linux-x64-rpm" })).toEqual(["linux-x64-rpm:true:false"])
		// Its legacy chain is not built: a notice, and install depth for it.
		expect(plan({ ...dispatch, platforms: "linux", depth: "deep", formats: "linux-x64-rpm" }, readiness).notices).toEqual([
			"Deep depth is not built yet for linux-x64-rpm legacy; they run at install depth."
		])
		// Named but not deep, or deep but not named: install depth.
		expect(deepWith({ ...dispatch, platforms: "linux", formats: "linux-x64-rpm" })).toEqual([])
		expect(deepWith({ ...dispatch, platforms: "linux", depth: "deep", formats: "linux-x64-deb" })).toEqual(["linux-x64-deb:true:true"])
		expect(deepWith({ ...dispatch, platforms: "linux", depth: "deep" }).some(entry => entry.includes("rpm"))).toBe(false)
		expect(
			deepWith({ ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" }).some(entry => entry.includes("rpm"))
		).toBe(false)
	})

	it("keeps install depth when asked and for spikes; legacy-only runs are deep too", () => {
		expect(plan({ ...dispatch, depth: "install" }).session).toBe(false)
		expect(deep({ ...dispatch, depth: "install" })).toEqual([])
		expect(deep({ ...dispatch, scenarios: "legacy" })).toEqual(["win-x64-nsis@0", "linux-x64-deb@20"])
		expect(deep({ ...dispatch, scenarios: "previous" })).toEqual(["win-x64-nsis@0", "linux-x64-deb@20"])
		expect(plan({ ...dispatch, scenarios: "legacy" }).tests.find(entry => entry.deep)?.previous).toBe(false)
		expect(plan({ ...dispatch, scenarios: "legacy" }).logins).toBe(SESSION_SLOTS + 2)
		expect(deep({ ...dispatch, spike: "s1" })).toEqual([])
		expect(deep({ ...dispatch, depth: "deep", formats: "linux-arm64-deb,linux-x64-rpm" })).toEqual(["linux-arm64-deb@0"])
		expect(() => plan({ ...dispatch, depth: "deepest" })).toThrow()
	})

	it("plans the cloud self-test with no build, no app and the harness sign-in", () => {
		expect(plan({ ...dispatch, spike: "cloud" })).toEqual({
			profile: "custom",
			spike: "cloud",
			session: true,
			logins: SESSION_SLOTS,
			pins: "",
			builds: [],
			tests: [],
			notices: []
		})
	})
})

describe("e2ePlan sign-ins", () => {
	const nightly = { ...dispatch, platforms: "", profile: "", eventName: "schedule", spike: "" }
	const release = { ...dispatch, profile: "release", eventName: "workflow_call", signed: true }
	const signIns = (input: PlanInput) =>
		plan(input)
			.tests.filter(entry => entry.deep && entry.lane === "")
			.map(
				entry =>
					`${entry.platform}-${entry.arch}-${entry.format} ${entry.signInPrevious}/${entry.signInLegacy}@${String(entry.stagger)}`
			)

	it("signs in through a form once per OS and chain, on different entries, rotated by the day at night", () => {
		expect(signIns({ ...nightly, day: 0 })).toEqual([
			"win-x64-nsis real/seeded@0",
			"win-arm64-nsis seeded/real@20",
			"mac-arm64-dmg real/real@40",
			"linux-x64-deb real/seeded@60",
			"linux-x64-AppImage seeded/real@80",
			"linux-arm64-deb seeded/seeded@0",
			"linux-arm64-AppImage seeded/seeded@0"
		])
		expect(signIns({ ...nightly, day: 1 })).toEqual([
			"win-x64-nsis seeded/real@0",
			"win-arm64-nsis real/seeded@20",
			"mac-arm64-dmg real/real@40",
			"linux-x64-deb seeded/seeded@0",
			"linux-x64-AppImage real/seeded@60",
			"linux-arm64-deb seeded/real@80",
			"linux-arm64-AppImage seeded/seeded@0"
		])
		// Linux's four entries take four nights to come round, Windows' two; macOS's one entry signs both chains in every night.
		expect(signIns({ ...nightly, day: 4 })).toEqual(signIns({ ...nightly, day: 0 }))
		expect(signIns({ ...nightly, day: 2 })).not.toEqual(signIns({ ...nightly, day: 0 }))
	})

	it("gives every OS exactly one real chain of each kind on different entries, every chain of every entry within days", () => {
		const formed = new Set<string>()

		for (const [input, days] of [
			[nightly, [0, 1, 2, 3, 4, 5, 6, 7, 20_000, 20_001]],
			[release, [0, 3]],
			[{ ...dispatch, signed: true }, [0, 5]],
			[{ ...dispatch, signed: true, depth: "deep" }, [0, 5]]
		] as const) {
			for (const day of days) {
				const result = plan({ ...input, day })
				// Each entry's own job (a second job runs 3.0.47 and chain K only).
				const deep = result.tests.filter(entry => entry.deep && entry.lane === "")

				expect(deep.length).toBe(input === nightly || input === release || input.depth === "deep" ? 7 : 3)
				expect(deep.every(entry => entry.deepPrevious && entry.deepLegacy)).toBe(true)

				for (const os of ["windows", "mac", "linux"] as const) {
					const ofOs = deep.filter(entry => entry.os === os)
					const realPrevious = ofOs.filter(entry => entry.signInPrevious === "real")
					const realLegacy = ofOs.filter(entry => entry.signInLegacy === "real")

					expect(realPrevious).toHaveLength(1)
					expect(realLegacy).toHaveLength(1)

					if (ofOs.length > 1) {
						expect(realPrevious[0]).not.toBe(realLegacy[0])
					}

					// Every other chain is seeded.
					expect(ofOs.filter(entry => entry.signInPrevious === "seeded")).toHaveLength(ofOs.length - 1)
					expect(ofOs.filter(entry => entry.signInLegacy === "seeded")).toHaveLength(ofOs.length - 1)
				}

				// A release also signs 3.0.47 in once (scripts/ci/olderPlan.ts); the quota account's sign-in on linux-x64-deb on top.
				expect(result.logins).toBe(SESSION_SLOTS + 6 + (input === release ? 1 : 0) + 1)
				expect(result.logins).toBeLessThanOrEqual(MAX_LOGINS_PER_RUN)

				if (input === nightly) {
					for (const entry of deep) {
						const id = `${entry.platform}-${entry.arch}-${entry.format}`

						if (entry.signInPrevious === "real") {
							formed.add(`${id} previous`)
						}

						if (entry.signInLegacy === "real") {
							formed.add(`${id} legacy`)
						}
					}
				}
			}
		}

		// Within the first four nights every deep entry's both forms have signed in.
		expect(formed.size).toBe(14)
	})

	it("keeps release and custom runs on one choice whatever the day", () => {
		expect(signIns({ ...release, day: 1 })).toEqual(signIns({ ...release, day: 0 }))
		expect(signIns({ ...nightly, day: 0 })).toEqual(signIns({ ...release, day: 7 }))
		expect(signIns({ ...dispatch, day: 3 })).toEqual(["win-x64-nsis real/real@0", "linux-x64-deb real/real@20"])
	})

	it("spaces only the entries that sign in through a form", () => {
		expect(signIns({ ...nightly, scenarios: "previous" })).toEqual([
			"win-x64-nsis real/@0",
			"win-arm64-nsis seeded/@0",
			"mac-arm64-dmg real/@20",
			"linux-x64-deb real/@40",
			"linux-x64-AppImage seeded/@0",
			"linux-arm64-deb seeded/@0",
			"linux-arm64-AppImage seeded/@0"
		])
	})

	it("signs every deep chain in through its form only when a custom run asks, within the run's login cap", () => {
		const custom = { ...dispatch, platforms: "windows,mac", signed: true, depth: "deep", signin: "real" }

		expect(signIns(custom)).toEqual(["win-x64-nsis real/real@0", "win-arm64-nsis real/real@20", "mac-arm64-dmg real/real@40"])
		// Both slots, then six form sign-ins: Windows' two entries both chains, macOS's one both chains.
		expect(plan(custom).logins).toBe(SESSION_SLOTS + 6)
		expect(plan(custom).logins).toBeLessThanOrEqual(MAX_LOGINS_PER_RUN)
		// Linux's four deep entries alone sign in eight times through forms, at the cap; every OS is above it.
		expect(plan({ ...custom, platforms: "linux" }).logins).toBe(MAX_LOGINS_PER_RUN)
		expect(() => plan({ ...custom, platforms: "" })).toThrow(/MAX_LOGINS_PER_RUN/)
		expect(plan({ ...custom, platforms: "", signin: "auto" }).logins).toBe(SESSION_SLOTS + 6 + 1)
		expect(() => plan({ ...nightly, signin: "real" })).toThrow(/custom profile only/)
		expect(() => plan({ ...dispatch, signin: "seeded" })).toThrow(/SIGNIN/)
		expect(plan({ ...dispatch, profile: "nightly", spike: "s7" }).logins).toBe(1)
		expect(plan({ ...dispatch, depth: "install" }).logins).toBe(0)
	})

	it("runs chain K on linux-x64-deb every night and release, by hand when named, with no session or login", () => {
		const nightly = plan({ ...dispatch, platforms: "", profile: "", eventName: "schedule", scenarios: "", spike: "" })
		const keyring = (input: PlanInput) =>
			plan(input)
				.tests.filter(entry => entry.keyring)
				.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)

		expect(keyring({ ...dispatch, platforms: "", profile: "", eventName: "schedule", scenarios: "", spike: "" })).toEqual([
			"linux-x64-deb"
		])
		expect(nightly.tests.find(entry => entry.keyring)?.deep).toBe(true)
		expect(keyring({ ...dispatch, profile: "release", eventName: "push", signed: true })).toEqual(["linux-x64-deb"])
		expect(keyring({ ...dispatch, profile: "release", eventName: "push", depth: "install" })).toEqual([])
		expect(keyring(dispatch)).toEqual([])
		expect(keyring({ ...dispatch, profile: "nightly", spike: "s1" })).toEqual([])

		// Alone by hand: one entry, deep for the harness, without the session job, a login or the update scenarios.
		const alone = plan({ ...dispatch, scenarios: "keyring" })

		expect(alone.tests.map(entry => [entry.platform, entry.arch, entry.format, entry.keyring, entry.deep])).toEqual([
			["linux", "x64", "deb", true, true]
		])
		expect(alone.tests[0]).toMatchObject({ previous: false, legacy: false, deepPrevious: false, deepLegacy: false, stagger: 0 })
		expect(alone.session).toBe(false)
		expect(alone.logins).toBe(0)
		expect(alone.builds.map(entry => entry.os)).toEqual(["linux"])
		expect(keyring({ ...dispatch, scenarios: "legacy,keyring", formats: "linux-x64-deb,win-x64-nsis" })).toEqual(["linux-x64-deb"])
		expect(() => plan({ ...dispatch, scenarios: "keyring", platforms: "windows" })).toThrow(/keyring runs on linux-x64-deb/)
		expect(() => plan({ ...dispatch, scenarios: "keyring", depth: "install" })).toThrow(/nothing to test/)
	})

	it("plans the keyring-mac spike on signed macOS arm64 only, with no session or login", () => {
		const spike = plan({ ...dispatch, profile: "nightly", spike: "keyring-mac" })

		expect(spike.tests.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)).toEqual(["mac-arm64-dmg"])
		expect(spike.tests.every(entry => !entry.deep && !entry.keyring && entry.spike === "keyring-mac")).toBe(true)
		expect(spike.session).toBe(false)
		expect(spike.logins).toBe(0)
		expect(() => plan({ ...dispatch, spike: "keyring-mac" })).toThrow(/Developer-ID-signed/)
		expect(plan({ ...dispatch, signed: true, spike: "keyring-mac" }).tests).toHaveLength(1)
	})

	it("counts the session job's slots", () => {
		expect(SESSION_SLOTS).toBe(Object.keys(SLOTS).length)
	})
})

describe("e2ePlan job timeouts", () => {
	const nightly = { ...dispatch, platforms: "", profile: "", eventName: "schedule", scenarios: "", spike: "" }
	const release = { ...dispatch, profile: "release", eventName: "workflow_call", signed: true }
	const text = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/desktop-e2e.yml", import.meta.url)), "utf8")
	const stepTimeout = (name: string) => {
		const start = text.indexOf(`- name: ${name}\n`)

		expect(start).toBeGreaterThan(-1)

		return Number(/timeout-minutes: (\d+)/.exec(text.slice(start, text.indexOf("\n      - name:", start + 1)))?.[1])
	}
	const idOf = (entry: { platform: string; arch: string; format: string }) => `${entry.platform}-${entry.arch}-${entry.format}`
	// Every Wednesday-or-not night, a release, and dispatches asking for everything.
	const runs: PlanInput[] = [
		...[0, 1, 2, 3, 4, 5, 6].map(day => ({ ...nightly, day })),
		release,
		{ ...release, depth: "install" },
		dispatch,
		{ ...dispatch, signed: true, scenarios: "previous,legacy,older,update-kill,keyring", depth: "deep" },
		{ ...dispatch, signed: true, scenarios: "older,update-kill,keyring" }
	]

	it("counts each step at the workflow's timeout for it", () => {
		expect(stepTimeout("N-1 -> N, signed in")).toBe(STEP_MINUTES.previousDeep)
		expect(stepTimeout("3.0.53 -> N, signed in")).toBe(STEP_MINUTES.legacyDeep)
		expect(stepTimeout("3.0.47 -> N, signed in")).toBe(STEP_MINUTES.olderDeep)
		expect(stepTimeout("3.0.47 -> N")).toBe(STEP_MINUTES.olderInstall)
		expect(stepTimeout("N-1 -> N, installer killed")).toBe(STEP_MINUTES.updateKill)
		expect(stepTimeout("Keyring chain K, no sign-in")).toBe(STEP_MINUTES.keyring)
		expect(stepTimeout("Spike ${{ matrix.spike }}")).toBe(STEP_MINUTES.spike)
		expect(text).toContain("timeout-minutes: ${{ matrix.timeout }}")
		expect(text).toContain("${{ matrix.lane && format(' {0}', matrix.lane) || '' }}")
		expect(text).toContain("${{ matrix.format }}${{ matrix.lane && format('-{0}', matrix.lane) || '' }}-${{ github.run_attempt }}")
	})

	it("gives every job its setup and steps, within a hosted runner's six hours, running each chain once", () => {
		for (const input of runs) {
			const result = plan(input)

			for (const entry of result.tests) {
				expect(entry.timeout).toBe(jobMinutes(entry))
				expect(entry.timeout).toBeLessThanOrEqual(JOB_MAX_MINUTES)
				expect(entry.timeout).toBeGreaterThanOrEqual(
					SETUP_MINUTES +
						(entry.deepPrevious ? STEP_MINUTES.previousDeep : 0) +
						(entry.deepLegacy ? STEP_MINUTES.legacyDeep : 0) +
						(entry.deepOlder ? STEP_MINUTES.olderDeep : entry.older ? STEP_MINUTES.olderInstall : 0) +
						(entry.keyring ? STEP_MINUTES.keyring : 0) +
						(entry.updateKill ? STEP_MINUTES.updateKill : 0)
				)
			}

			for (const chain of ["deepPrevious", "deepLegacy", "older", "keyring", "updateKill", "quota"] as const) {
				const holders = result.tests.filter(entry => entry[chain]).map(idOf)

				expect(new Set(holders).size).toBe(holders.length)
			}
		}
	})

	it("runs 3.0.47 and chain K in a second job where an entry's chains overrun six hours", () => {
		const lanes = (input: PlanInput) =>
			plan(input)
				.tests.filter(entry => entry.lane !== "")
				.map(entry => `${idOf(entry)} ${entry.lane}`)

		expect(lanes(release)).toEqual(["win-x64-nsis older", "mac-arm64-dmg older", "linux-x64-deb older-keyring"])
		// A Wednesday night: chain K and the install-depth 3.0.47 update beside P and L on the deb.
		expect(lanes({ ...nightly, day: 6 })).toEqual(["linux-x64-deb older-keyring"])
		expect(lanes({ ...nightly, day: 0 })).toEqual([])

		const second = plan(release).tests.find(entry => entry.lane === "older-keyring")

		expect(second).toMatchObject({
			previous: false,
			legacy: false,
			deepPrevious: false,
			deepLegacy: false,
			updateKill: false,
			quota: false,
			deep: true,
			older: true,
			deepOlder: true,
			keyring: true
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
