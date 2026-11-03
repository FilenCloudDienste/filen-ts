import { appendFileSync, readFileSync } from "node:fs"

// Plans .github/workflows/desktop-e2e.yml: the candidate version N (package.json), the lower version N-1 is built as,
// and the build and test matrices. Written to $GITHUB_OUTPUT when set. Every input arrives through the environment
// and is validated here.
//
//   PLATFORMS   comma-separated subset of windows,mac,linux (default all)
//   PROFILE     release | nightly | custom; empty means nightly for a scheduled run, custom otherwise
//   SIGNED      true | false: sign every build (release and custom); nightly signs macOS only, never notarized
//   SCENARIOS   comma-separated subset of previous,legacy (default both); LEGACY=false drops legacy too
//   FORMATS     custom only: entries such as win-x64-nsis,linux-x64-deb (default all)
//   DEPTH       auto | install | deep: auto takes the profile's deep entries, deep those of a release (and any
//               DEEP_TRIAL entry FORMATS names)
//   SPIKE       none | s1 | s7 | cloud | offline: a dispatch-only spike instead of the update scenarios (cloud: the
//               harness's cloud self-test, no app; offline: deep N-1 -> N with an offline/reconnect probe, signed in)
//   SIGNIN      custom only: auto | real. auto signs in through a form once per OS and chain (the rest seeded), real
//               signs every deep chain in through its form
//
// Deep entries are signed in: `session` tells the workflow to provide the run's sessions (job `session`: cached, or one
// harness login per slot), and each deep chain signs in through its app's real form or is seeded with that session
// (scripts/ci/e2e/seed.ts). Logins are rate-limited (90 an hour per IP), so per OS one 4.x and one 3.0.53 chain sign in
// for real, on different entries where the OS has more than one: rotated by the day at night, so every entry's form
// is exercised within days, and fixed in release and custom runs. Entries whose chains sign in for real get a
// `stagger` (seconds) that spaces those sign-ins between parallel jobs. `logins` is the run's worst case (every slot
// minted), which may not pass MAX_LOGINS_PER_RUN.
//
//   node scripts/ci/e2ePlan.ts

export type Os = "windows" | "mac" | "linux"
export type Profile = "release" | "nightly" | "custom"
export type Spike = "s1" | "s7" | "cloud" | "offline"
export type Depth = "auto" | "install" | "deep"
// How a deep chain signs in: through its app's real form, or seeded with the run's session (scripts/ci/e2e/seed.ts).
export type SignIn = "real" | "seeded"

interface Entry {
	os: Os
	platform: "win" | "mac" | "linux"
	arch: "x64" | "arm64"
	format: "nsis" | "dmg" | "deb" | "rpm" | "AppImage"
	runner: string
}

export interface TestEntry extends Entry {
	signed: boolean
	previous: boolean
	legacy: boolean
	// The entry runs a chain deep (it needs the harness and its dependencies); which ones: deepPrevious, deepLegacy.
	deep: boolean
	deepPrevious: boolean
	deepLegacy: boolean
	// "" where that chain is not deep.
	signInPrevious: SignIn | ""
	signInLegacy: SignIn | ""
	stagger: number
	spike: Spike | ""
}

export interface BuildEntry {
	os: Os
	runner: string
	sign: boolean
}

export interface PlanInput {
	platforms: string
	profile: string
	eventName: string
	signed: boolean
	scenarios: string
	legacy: boolean
	formats: string
	depth: string
	spike: string
	signin: string
	// Days since the Unix epoch (UTC): the nightly's rotation of real sign-ins.
	day: number
}

export interface Plan {
	profile: Profile
	spike: Spike | ""
	// The run's sessions are needed (job `session`).
	session: boolean
	// The most logins the run can make: every session slot minted, every real UI sign-in.
	logins: number
	builds: BuildEntry[]
	tests: TestEntry[]
	notices: string[]
}

// Below N in semver whatever N is (a prerelease N still sorts above its own core's predecessor), and always X.Y.Z with
// parts NSIS's four-part file version accepts.
export function previousVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)

	if (!match) {
		throw new Error(`${version} is not a semver version`)
	}

	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]

	if (patch > 0) {
		return `${String(major)}.${String(minor)}.${String(patch - 1)}`
	}

	if (minor > 0) {
		return `${String(major)}.${String(minor - 1)}.999`
	}

	if (major > 0) {
		return `${String(major - 1)}.999.999`
	}

	throw new Error(`${version} has no lower X.Y.Z version`)
}

const entries: Entry[] = [
	{ os: "windows", platform: "win", arch: "x64", format: "nsis", runner: "windows-latest" },
	{ os: "windows", platform: "win", arch: "arm64", format: "nsis", runner: "windows-11-arm" },
	{ os: "mac", platform: "mac", arch: "arm64", format: "dmg", runner: "macos-26" },
	{ os: "mac", platform: "mac", arch: "x64", format: "dmg", runner: "macos-26-intel" },
	...(["x64", "arm64"] as const).flatMap(arch =>
		(["deb", "rpm", "AppImage"] as const).map((format): Entry => ({
			os: "linux",
			platform: "linux",
			arch,
			format,
			runner: arch === "x64" ? "ubuntu-24.04" : "ubuntu-24.04-arm"
		}))
	)
]

// One entry per OS, on the format each spike asks about (cloud runs no app).
const spikeEntries: Record<Spike, readonly string[]> = {
	s1: ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"],
	s7: ["mac-arm64-dmg"],
	cloud: [],
	offline: ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"]
}

// Deep depth per profile: release and nightly on every OS and architecture's main format, plus macOS x64 and both
// AppImages, whose updaters and process trees differ (no rotation: all of them every night), by hand one per OS unless
// DEPTH says otherwise. rpm stays at install depth: its updater is the deb's with another package manager.
const DEEP_FORMATS = [
	"win-x64-nsis",
	"win-arm64-nsis",
	"mac-arm64-dmg",
	"mac-x64-dmg",
	"linux-x64-deb",
	"linux-arm64-deb",
	"linux-x64-AppImage",
	"linux-arm64-AppImage"
]
const deepEntries: Record<Profile, readonly string[]> = {
	release: DEEP_FORMATS,
	nightly: DEEP_FORMATS,
	custom: ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"]
}
// Which deep chains are built so far, per entry; the rest of a deep request runs at install depth, with a notice.
export type DeepScenarios = Readonly<Record<string, readonly ("previous" | "legacy")[]>>

export interface DeepReadiness {
	// Deep in every profile that asks for it.
	ready: DeepScenarios
	// Deep only when a custom deep run names the entry in FORMATS.
	trial: DeepScenarios
}

export const DEEP_READY: DeepScenarios = {
	"win-x64-nsis": ["previous", "legacy"],
	"win-arm64-nsis": ["previous", "legacy"],
	"mac-arm64-dmg": ["previous", "legacy"],
	"mac-x64-dmg": ["previous", "legacy"],
	"linux-x64-deb": ["previous", "legacy"],
	"linux-arm64-deb": ["previous", "legacy"],
	"linux-x64-AppImage": ["previous", "legacy"],
	"linux-arm64-AppImage": ["previous", "legacy"]
}
// Deep chains being brought up: deep only when a custom run names the entry in FORMATS with DEPTH deep, so nightly and
// release runs stay on what is proven.
export const DEEP_TRIAL: DeepScenarios = {}
// Seconds between the UI sign-ins of parallel deep jobs.
const STAGGER_SECONDS = 20
// The session job's slots, each minted at most once a run (scripts/ci/e2e/session.ts SLOTS; this planner runs with no
// dependencies installed, so it cannot import them).
export const SESSION_SLOTS = 2
// A run's worst case, whatever is asked: with MAX_OTHER_RUNS others (desktop-e2e.yml) the account stays well inside
// its 90 logins an hour even if every runner shared one IP.
export const MAX_LOGINS_PER_RUN = 10

const builders: Record<Os, string> = { windows: "windows-latest", mac: "macos-26", linux: "ubuntu-latest" }

function idOf(entry: Entry): string {
	return `${entry.platform}-${entry.arch}-${entry.format}`
}

function list(value: string): string[] {
	return value
		.split(",")
		.map(item => item.trim())
		.filter(item => item !== "")
}

function invalid(message: string): never {
	throw new Error(message)
}

export function plan(input: PlanInput, readiness: DeepReadiness = { ready: DEEP_READY, trial: DEEP_TRIAL }): Plan {
	const requested = input.platforms.trim() === "" ? (Object.keys(builders) as Os[]) : list(input.platforms)
	const unknown = requested.filter(item => !Object.hasOwn(builders, item))

	if (unknown.length > 0 || requested.length === 0) {
		invalid(`PLATFORMS must list some of windows, mac, linux (got "${input.platforms}")`)
	}

	const profileName = input.profile === "" ? (input.eventName === "schedule" ? "nightly" : "custom") : input.profile
	const profile = (["release", "nightly", "custom"] as const).find(candidate => candidate === profileName)

	if (profile === undefined) {
		invalid(`PROFILE must be release, nightly or custom (got "${input.profile}")`)
	}

	const spikeName = input.spike === "none" ? "" : input.spike
	const spike = (["", "s1", "s7", "cloud", "offline"] as const).find(candidate => candidate === spikeName)

	if (spike === undefined) {
		invalid(`SPIKE must be none, s1, s7, cloud or offline (got "${input.spike}")`)
	}

	const depth = (["auto", "install", "deep"] as const).find(candidate => candidate === (input.depth === "" ? "auto" : input.depth))

	if (depth === undefined) {
		invalid(`DEPTH must be auto, install or deep (got "${input.depth}")`)
	}

	const signin = (["auto", "real"] as const).find(candidate => candidate === (input.signin === "" ? "auto" : input.signin))

	if (signin === undefined) {
		invalid(`SIGNIN must be auto or real (got "${input.signin}")`)
	}

	if (signin === "real" && profile !== "custom") {
		invalid("SIGNIN real applies to the custom profile only")
	}

	if (spike === "cloud") {
		return { profile, spike, session: true, logins: SESSION_SLOTS, builds: [], tests: [], notices: [] }
	}

	const scenarios = input.scenarios.trim() === "" ? ["previous", "legacy"] : list(input.scenarios)

	if (scenarios.length === 0 || scenarios.some(item => item !== "previous" && item !== "legacy")) {
		invalid(`SCENARIOS must list some of previous, legacy (got "${input.scenarios}")`)
	}

	const formats = list(input.formats)

	if (formats.length > 0 && profile !== "custom") {
		invalid("FORMATS applies to the custom profile only")
	}

	const known = new Set(entries.map(idOf))
	const unknownFormats = formats.filter(item => !known.has(item))

	if (unknownFormats.length > 0) {
		invalid(`FORMATS names unknown entries: ${unknownFormats.join(", ")} (known: ${[...known].join(", ")})`)
	}

	// Nightly: Developer ID on macOS (Squirrel.Mac needs it), nothing on Windows (an update without a publisherName in
	// app-update.yml is not signature-checked) and no notarization anywhere.
	const sign: Record<Os, boolean> =
		profile === "nightly"
			? { windows: false, mac: true, linux: false }
			: { windows: input.signed, mac: input.signed, linux: input.signed }
	const notices: string[] = []

	if (spike === "s7" && !sign.mac) {
		invalid("spike s7 needs a Developer-ID-signed macOS build: dispatch with signed: true or profile: nightly")
	}

	// Squirrel.Mac installs an update only if it satisfies the running app's designated requirement, which ad-hoc signed
	// builds never do, so unsigned runs leave macOS out (spikes too: macOS is only ever packaged signed here).
	if (!sign.mac && requested.includes("mac")) {
		notices.push("macOS is not tested unsigned: Squirrel.Mac needs both builds signed by the same Developer ID.")
	}

	const oses = (Object.keys(builders) as Os[]).filter(os => requested.includes(os) && (sign.mac || os !== "mac"))
	const chosen = entries.filter(entry => {
		if (!oses.includes(entry.os)) {
			return false
		}

		if (spike !== "") {
			return spikeEntries[spike].includes(idOf(entry))
		}

		return formats.length === 0 || formats.includes(idOf(entry))
	})

	const previous = spike === "" && scenarios.includes("previous")
	const legacy = spike === "" && scenarios.includes("legacy") && input.legacy

	if (chosen.length === 0 || (spike === "" && !previous && !legacy)) {
		invalid("nothing to test")
	}

	const trial = profile === "custom" && depth === "deep"
	// A trial entry is wanted wherever it is named: it may be a format no profile runs deep yet.
	const wantsDeep = (id: string) =>
		spike === "" &&
		(previous || legacy) &&
		depth !== "install" &&
		((depth === "deep" ? DEEP_FORMATS : deepEntries[profile]).includes(id) ||
			(trial && formats.includes(id) && Object.hasOwn(readiness.trial, id)))
	const ready = (id: string, scenario: "previous" | "legacy") =>
		readiness.ready[id]?.includes(scenario) === true ||
		(trial && formats.includes(id) && readiness.trial[id]?.includes(scenario) === true)
	const notReady = chosen
		.map(idOf)
		.flatMap(id =>
			wantsDeep(id)
				? [
						...(previous && !ready(id, "previous") ? [`${id} previous`] : []),
						...(legacy && !ready(id, "legacy") ? [`${id} legacy`] : [])
					]
				: []
		)

	if (notReady.length > 0) {
		notices.push(`Deep depth is not built yet for ${notReady.join(", ")}; they run at install depth.`)
	}

	const deepChains = chosen.map(entry => {
		const id = idOf(entry)

		// The offline spike is chain P at deep depth with its probe.
		return {
			entry,
			deepPrevious: spike === "offline" || (previous && wantsDeep(id) && ready(id, "previous")),
			deepLegacy: legacy && wantsDeep(id) && ready(id, "legacy")
		}
	})
	// Per OS, the entries whose chain signs in for real: one 4.x and one 3.0.53, the next entry along for 3.0.53, so the
	// two land on different entries where there are two. At night the turn is the day's; otherwise the first.
	const turn = profile === "nightly" ? input.day : 0
	const real = (chain: "deepPrevious" | "deepLegacy", offset: number): Set<Entry> =>
		new Set(
			oses.flatMap(os => {
				const candidates = deepChains.filter(item => item.entry.os === os && item[chain]).map(item => item.entry)
				const pick = candidates[(turn + offset) % Math.max(candidates.length, 1)]

				return signin === "real" ? candidates : pick === undefined ? [] : [pick]
			})
		)
	const realPrevious = real("deepPrevious", 0)
	const realLegacy = real("deepLegacy", 1)
	const signInOf = (deep: boolean, isReal: boolean): SignIn | "" => (!deep ? "" : isReal ? "real" : "seeded")

	let realCount = 0
	const tests = deepChains.map(({ entry, deepPrevious, deepLegacy }): TestEntry => {
		const signInPrevious = signInOf(deepPrevious, realPrevious.has(entry))
		const signInLegacy = signInOf(deepLegacy, realLegacy.has(entry))

		return {
			...entry,
			signed: sign[entry.os],
			previous,
			legacy,
			deep: deepPrevious || deepLegacy,
			deepPrevious,
			deepLegacy,
			signInPrevious,
			signInLegacy,
			// Only the form sign-ins are spaced; a seeded chain makes no login.
			stagger: signInPrevious === "real" || signInLegacy === "real" ? STAGGER_SECONDS * realCount++ : 0,
			spike
		}
	})
	const builds = (Object.keys(builders) as Os[])
		.filter(os => tests.some(entry => entry.os === os))
		.map((os): BuildEntry => ({ os, runner: builders[os], sign: sign[os] }))

	const session = tests.some(entry => entry.deep)
	// Spike s7 signs in through the 4.x form on its own.
	const logins =
		(session ? SESSION_SLOTS : 0) +
		tests.reduce(
			(sum, entry) =>
				sum + Number(entry.signInPrevious === "real") + Number(entry.signInLegacy === "real") + Number(entry.spike === "s7"),
			0
		)

	if (logins > MAX_LOGINS_PER_RUN) {
		invalid(
			`the run could log in ${String(logins)} times, more than MAX_LOGINS_PER_RUN (${String(MAX_LOGINS_PER_RUN)}): name fewer formats or sign in with auto`
		)
	}

	return { profile, spike, session, logins, builds, tests, notices }
}

if (import.meta.main) {
	const env = (name: string) => process.env[name] ?? ""

	try {
		const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
		const result = plan({
			platforms: env("PLATFORMS"),
			profile: env("PROFILE"),
			eventName: env("GITHUB_EVENT_NAME"),
			signed: env("SIGNED") !== "false",
			scenarios: env("SCENARIOS"),
			legacy: env("LEGACY") !== "false",
			formats: env("FORMATS"),
			depth: env("DEPTH"),
			spike: env("SPIKE"),
			signin: env("SIGNIN"),
			day: Math.floor(Date.now() / 86_400_000)
		})

		for (const notice of result.notices) {
			console.log(`::notice::${notice}`)
		}

		const outputs = {
			profile: result.profile,
			spike: result.spike,
			session: String(result.session),
			logins: String(result.logins),
			"next-version": version,
			"prev-version": previousVersion(version),
			"build-matrix": JSON.stringify({ include: result.builds }),
			"test-matrix": JSON.stringify({ include: result.tests })
		}

		for (const [key, value] of Object.entries(outputs)) {
			console.log(`${key}=${value}`)

			if (process.env["GITHUB_OUTPUT"]) {
				appendFileSync(process.env["GITHUB_OUTPUT"], `${key}=${value}\n`)
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
