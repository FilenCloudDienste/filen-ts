import { appendFileSync, readFileSync } from "node:fs"
import { LEGACY_PIN, OLDER_PIN } from "./legacy.ts"
import { OLDER_SCENARIO, olderFor, runsOlder } from "./olderPlan.ts"

// Plans .github/workflows/desktop-e2e.yml: the candidate version N (package.json), the lower version N-1 is built as,
// and the build and test matrices. Written to $GITHUB_OUTPUT when set. Every input arrives through the environment
// and is validated here.
//
//   PLATFORMS   comma-separated subset of windows,mac,linux (default all)
//   PROFILE     release | nightly | custom; empty means nightly for a scheduled run, custom otherwise
//   SIGNED      true | false: sign every build (release and custom); nightly signs macOS only, never notarized
//   SCENARIOS   comma-separated subset of previous,legacy,older,update-kill,keyring,dragout (default previous,legacy);
//               LEGACY=false drops legacy and older. older (3.0.47 -> N, scripts/ci/olderPlan.ts) runs at release and
//               one night a week with legacy, by hand only when named. update-kill (N-1's installer killed mid-install,
//               install depth) runs in every release run and when named; never at night, and not for rpm. keyring
//               (chain K, no sign-in) runs on linux-x64-deb: in every nightly and release run that is not at install
//               depth, and in a custom one that names it. dragout (chain D, drag-out with real OS input, seeded) runs
//               where DEEP_READY lists it in every nightly and release run that is not at install depth, by hand when
//               named; where only DEEP_TRIAL lists it, in a custom deep run that names it and the entry in FORMATS
//   FORMATS     custom only: entries such as win-x64-nsis,linux-x64-deb (default all)
//   DEPTH       auto | install | deep: auto takes the profile's deep entries, deep those of a release (and any
//               DEEP_TRIAL entry FORMATS names)
//   SPIKE       none | s1 | s7 | cloud | offline | keyring-mac: a dispatch-only spike instead of the update scenarios
//               (cloud: the harness's cloud self-test, no app; offline: deep N-1 -> N with an offline/reconnect probe,
//               signed in; keyring-mac: a locked keychain under 3.x -> N's import, signed macOS, no sign-in)
//   SIGNIN      custom only: auto | real. auto signs in through a form once per OS and chain (the rest seeded), real
//               signs every deep chain in through its form
//
// Deep entries are signed in: `session` tells the workflow to provide the run's sessions (job `session`: cached, or one
// harness login per slot), and each deep chain signs in through its app's real form or is seeded with that session
// (scripts/ci/e2e/seed.ts). Logins are rate-limited (90 an hour per IP), so per OS one 4.x and one 3.0.53 chain sign in
// for real, on different entries where the OS has more than one: rotated by the day at night, so every entry's form
// is exercised within days, and fixed in release and custom runs. Entries whose chains sign in for real get a
// `stagger` (seconds) that spaces those sign-ins between parallel jobs. `logins` is the run's worst case (every slot
// minted), which may not pass MAX_LOGINS_PER_RUN. Chain P on QUOTA_ENTRY also signs in once on the quota account
// (`quota`, the cloud-storage-full check) when that still fits. `pins` names the old clients the run signs in or seeds,
// whose SDK must take the account's auth version (checked by job `session`).
//
// Each entry gets one test job, whose `timeout` is its setup plus every step it can run at that step's timeout
// (jobMinutes). Where that overruns the six hours a hosted runner allows (JOB_MAX_MINUTES), the entry's 3.0.47 chain,
// chain K and chain D run in a second job (`lane`), listed after every entry's first.
//
//   node scripts/ci/e2ePlan.ts

export type Os = "windows" | "mac" | "linux"
export type Profile = "release" | "nightly" | "custom"
export type Spike = "s1" | "s7" | "cloud" | "offline" | "keyring-mac"
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
	// 3.0.47 -> N (scripts/ci/olderPlan.ts): at all, deep, and how its deep chain signs in ("" where it is not deep).
	older: boolean
	deepOlder: boolean
	signInOlder: SignIn | ""
	// Chain K on this entry (no sign-in; it needs the harness, so it makes the entry deep).
	keyring: boolean
	// Chain D on this entry (scripts/ci/e2e/chains/dragOut.ts): seeded with the run's session, never a form sign-in.
	dragout: boolean
	stagger: number
	spike: Spike | ""
	// Scenario update-kill (scripts/ci/e2e/updateKill.ts).
	updateKill: boolean
	// Chain P also runs the cloud-storage-full check, which signs in once through the form on the quota account.
	quota: boolean
	// "" for the entry's job; else the second job of an entry whose chains do not fit one (jobMinutes), named by what
	// it runs ("older", "keyring", "dragout" or a combination such as "older-keyring").
	lane: string
	// The job's timeout-minutes (jobMinutes).
	timeout: number
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
	// The old clients' versions the run signs in or seeds, comma-separated ("" for none).
	pins: string
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
	offline: ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"],
	"keyring-mac": ["mac-arm64-dmg"]
}
// Chain K's entry: the deb, whose N runs on the session's own D-Bus and Secret Service.
const KEYRING_ENTRY = "linux-x64-deb"

// Deep depth per profile: release and nightly on every OS and architecture's main format, plus both AppImages, whose
// updaters and process trees differ (no rotation: all of them every night), by hand one per OS unless DEPTH says
// otherwise. rpm stays at install depth: its updater is the deb's with another package manager. macOS x64 stays at
// install depth: Intel Macs end with macOS 26, and the Intel runner's open panel often never appears.
const DEEP_FORMATS = [
	"win-x64-nsis",
	"win-arm64-nsis",
	"mac-arm64-dmg",
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
// dragout is chain D, which needs no update and runs beside the update scenarios (or alone) on the entries listed.
export type DeepChain = "previous" | "legacy" | "dragout"
export type DeepScenarios = Readonly<Record<string, readonly DeepChain[]>>

export interface DeepReadiness {
	// Deep in every profile that asks for it.
	ready: DeepScenarios
	// Deep only when a custom deep run names the entry in FORMATS.
	trial: DeepScenarios
}

export const DEEP_READY: DeepScenarios = {
	"win-x64-nsis": ["previous", "legacy", "dragout"],
	"win-arm64-nsis": ["previous", "legacy"],
	"mac-arm64-dmg": ["previous", "legacy"],
	"linux-x64-deb": ["previous", "legacy", "dragout"],
	"linux-arm64-deb": ["previous", "legacy", "dragout"],
	"linux-x64-AppImage": ["previous", "legacy"],
	"linux-arm64-AppImage": ["previous", "legacy"]
}
// Deep chains being brought up: deep only when a custom run names the entry in FORMATS with DEPTH deep, so nightly and
// release runs stay on what is proven. Chain D moves to DEEP_READY once it has passed on an entry.
export const DEEP_TRIAL: DeepScenarios = {
	"win-arm64-nsis": ["dragout"],
	"mac-arm64-dmg": ["dragout"]
}
// Seconds between the UI sign-ins of parallel deep jobs.
const STAGGER_SECONDS = 20
// The session job's slots, each minted at most once a run (scripts/ci/e2e/session.ts SLOTS; this planner runs with no
// dependencies installed, so it cannot import them).
export const SESSION_SLOTS = 2
// The entry whose chain P checks the cloud storage full (the quota account), when the run's logins leave room for its
// sign-in.
export const QUOTA_ENTRY = "linux-x64-deb"
// A run's worst case, whatever is asked: with MAX_OTHER_RUNS others (desktop-e2e.yml) the account stays well inside
// its 90 logins an hour even if every runner shared one IP.
export const MAX_LOGINS_PER_RUN = 10

// The test job's step timeouts (desktop-e2e.yml; the tests hold the two to each other) and the minutes around them
// (checkout, installs, downloads). The install-depth N-1 and 3.0.53 steps have no timeout of their own: `install`.
export const STEP_MINUTES = {
	previousDeep: 165,
	legacyDeep: 120,
	olderDeep: 120,
	olderInstall: 30,
	updateKill: 45,
	keyring: 45,
	dragout: 45,
	spike: 20,
	install: 35
} as const
export const SETUP_MINUTES = 20
// GitHub-hosted runners end a job after six hours whatever its timeout-minutes says.
export const JOB_MAX_MINUTES = 360
// What a job gets at the least (an install-depth entry's).
const JOB_MIN_MINUTES = 90

export type JobParts = Pick<
	TestEntry,
	"previous" | "legacy" | "deepPrevious" | "deepLegacy" | "older" | "deepOlder" | "keyring" | "dragout" | "updateKill" | "spike"
>

// A job's timeout: its setup and every step it can run, each at its timeout.
export function jobMinutes(parts: JobParts): number {
	const steps = [
		parts.deepPrevious ? STEP_MINUTES.previousDeep : parts.previous ? STEP_MINUTES.install : 0,
		parts.deepLegacy ? STEP_MINUTES.legacyDeep : parts.legacy ? STEP_MINUTES.install : 0,
		parts.deepOlder ? STEP_MINUTES.olderDeep : parts.older ? STEP_MINUTES.olderInstall : 0,
		parts.keyring ? STEP_MINUTES.keyring : 0,
		parts.dragout ? STEP_MINUTES.dragout : 0,
		parts.updateKill ? STEP_MINUTES.updateKill : 0,
		parts.spike !== "" && !parts.deepPrevious ? STEP_MINUTES.spike : 0
	]

	return Math.max(JOB_MIN_MINUTES, SETUP_MINUTES + steps.reduce((sum, minutes) => sum + minutes, 0))
}

// An entry's jobs: one, or where its chains overrun JOB_MAX_MINUTES, the 3.0.47 chain, chain K and chain D in a second
// job on a runner of their own (they share nothing with chains P and L but the build).
export function splitJob(parts: JobParts): JobParts[] {
	if (jobMinutes(parts) <= JOB_MAX_MINUTES || !(parts.older || parts.keyring || parts.dragout)) {
		return [parts]
	}

	return [
		{ ...parts, older: false, deepOlder: false, keyring: false, dragout: false },
		{
			...parts,
			previous: false,
			legacy: false,
			deepPrevious: false,
			deepLegacy: false,
			updateKill: false
		}
	]
}

function laneOf(parts: JobParts): string {
	return [parts.older ? "older" : "", parts.keyring ? "keyring" : "", parts.dragout ? "dragout" : ""]
		.filter(part => part !== "")
		.join("-")
}

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
	const spike = (["", "s1", "s7", "cloud", "offline", "keyring-mac"] as const).find(candidate => candidate === spikeName)

	if (spike === undefined) {
		invalid(`SPIKE must be none, s1, s7, cloud, offline or keyring-mac (got "${input.spike}")`)
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
		return { profile, spike, session: true, logins: SESSION_SLOTS, pins: "", builds: [], tests: [], notices: [] }
	}

	const scenarios = input.scenarios.trim() === "" ? ["previous", "legacy"] : list(input.scenarios)

	if (
		scenarios.length === 0 ||
		scenarios.some(
			item =>
				item !== "previous" &&
				item !== "legacy" &&
				item !== OLDER_SCENARIO &&
				item !== "update-kill" &&
				item !== "keyring" &&
				item !== "dragout"
		)
	) {
		invalid(`SCENARIOS must list some of previous, legacy, older, update-kill, keyring, dragout (got "${input.scenarios}")`)
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

	if ((spike === "s7" || spike === "keyring-mac") && !sign.mac) {
		invalid(`spike ${spike} needs a Developer-ID-signed macOS build: dispatch with signed: true or profile: nightly`)
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
	const updateKill = spike === "" && (profile === "release" || scenarios.includes("update-kill"))
	const killed = (entry: Entry) => updateKill && entry.format !== "rpm"
	const older = runsOlder({ profile, scenarios, legacy: input.legacy, spike, day: input.day })
	const keyring = spike === "" && depth !== "install" && (profile === "custom" ? scenarios.includes("keyring") : true)
	const keyringOn = (entry: Entry) => keyring && idOf(entry) === KEYRING_ENTRY
	const trial = profile === "custom" && depth === "deep"
	// Chain D: asked for at night and at release (where DEEP_READY lists it), by hand when named; never at install depth.
	const dragout = spike === "" && depth !== "install" && (profile === "custom" ? scenarios.includes("dragout") : true)
	const dragoutOn = (entry: Entry) => {
		const id = idOf(entry)

		return (
			dragout &&
			(readiness.ready[id]?.includes("dragout") === true ||
				(trial && formats.includes(id) && readiness.trial[id]?.includes("dragout") === true))
		)
	}

	if (chosen.length === 0 || (spike === "" && !previous && !legacy && !older && !keyring && !dragout && !chosen.some(killed))) {
		invalid("nothing to test")
	}

	// update-kill alone: only the entries it runs on (not rpm).
	if (spike === "" && !previous && !legacy && !older && !keyring && !dragout) {
		chosen.splice(0, chosen.length, ...chosen.filter(killed))
	}

	// Chain D named by hand on an entry it is only being brought up on.
	if (profile === "custom" && dragout) {
		const waiting = chosen
			.map(idOf)
			.filter(id => readiness.ready[id]?.includes("dragout") !== true && readiness.trial[id]?.includes("dragout") === true)
			.filter(id => !(trial && formats.includes(id)))

		if (waiting.length > 0) {
			notices.push(`Chain D is in trial on ${waiting.join(", ")}: it runs there only with depth deep and the entry named in formats.`)
		}
	}

	// A trial entry is wanted wherever it is named: it may be a format no profile runs deep yet.
	const wantsDeep = (id: string) =>
		spike === "" &&
		(previous || legacy || older) &&
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
			deepLegacy: legacy && wantsDeep(id) && ready(id, "legacy"),
			...olderFor(id, older, wantsDeep(id), profile)
		}
	})
	// An entry with nothing to run (3.0.47, update-kill or chain K without the update scenarios, elsewhere) gets no job.
	const running = deepChains.filter(
		item => spike !== "" || previous || legacy || item.older || killed(item.entry) || keyringOn(item.entry) || dragoutOn(item.entry)
	)

	if (running.length === 0) {
		invalid(
			`nothing to test: keyring runs on ${KEYRING_ENTRY} only; dragout runs where DEEP_READY lists it, or with depth deep on the DEEP_TRIAL entries named in formats`
		)
	}

	// Per OS, the entries whose chain signs in for real: one 4.x and one 3.0.53, the next entry along for 3.0.53, so the
	// two land on different entries where there are two. At night the turn is the day's; otherwise the first.
	const turn = profile === "nightly" ? input.day : 0
	const real = (chain: "deepPrevious" | "deepLegacy", offset: number): Set<Entry> =>
		new Set(
			oses.flatMap(os => {
				const candidates = running.filter(item => item.entry.os === os && item[chain]).map(item => item.entry)
				const pick = candidates[(turn + offset) % Math.max(candidates.length, 1)]

				return signin === "real" ? candidates : pick === undefined ? [] : [pick]
			})
		)
	const realPrevious = real("deepPrevious", 0)
	const realLegacy = real("deepLegacy", 1)
	// 3.0.47: one real sign-in a run over every OS (the first deep entry), the others seeded.
	const olderCandidates = running.filter(item => item.deepOlder).map(item => item.entry)
	const realOlder = new Set(signin === "real" ? olderCandidates : olderCandidates.slice(0, 1))
	const signInOf = (deep: boolean, isReal: boolean): SignIn | "" => (!deep ? "" : isReal ? "real" : "seeded")

	const perEntry = running.map(({ entry, deepPrevious, deepLegacy, older: olderEntry, deepOlder }) => {
		const parts: JobParts = {
			previous,
			legacy,
			deepPrevious,
			deepLegacy,
			older: olderEntry,
			deepOlder,
			keyring: keyringOn(entry),
			dragout: dragoutOn(entry),
			updateKill: killed(entry),
			spike
		}
		return splitJob(parts).map((job, index) => ({ entry, job, lane: index === 0 ? "" : laneOf(job) }))
	})
	// Every entry's job, then the second jobs, so the first ones' sign-ins keep their spacing.
	const jobs = [...perEntry.map(([first]) => first), ...perEntry.flatMap(([, ...rest]) => rest)].filter(job => job !== undefined)

	let realCount = 0
	const tests = jobs.map(({ entry, job, lane }): TestEntry => {
		const signInPrevious = signInOf(job.deepPrevious, realPrevious.has(entry))
		const signInLegacy = signInOf(job.deepLegacy, realLegacy.has(entry))
		const signInOlder = signInOf(job.deepOlder, realOlder.has(entry))
		const timeout = jobMinutes(job)

		if (timeout > JOB_MAX_MINUTES) {
			invalid(`${idOf(entry)}'s job needs ${String(timeout)} minutes, more than JOB_MAX_MINUTES (${String(JOB_MAX_MINUTES)})`)
		}

		return {
			...entry,
			signed: sign[entry.os],
			...job,
			deep: job.deepPrevious || job.deepLegacy || job.deepOlder || job.keyring || job.dragout,
			signInPrevious,
			signInLegacy,
			signInOlder,
			// Only the form sign-ins are spaced, per job; a seeded chain makes no login.
			stagger: signInPrevious === "real" || signInLegacy === "real" || signInOlder === "real" ? STAGGER_SECONDS * realCount++ : 0,
			quota: false,
			lane,
			timeout
		}
	})
	const builds = (Object.keys(builders) as Os[])
		.filter(os => tests.some(entry => entry.os === os))
		.map((os): BuildEntry => ({ os, runner: builders[os], sign: sign[os] }))

	// Chain K signs nothing in and reaches no cloud; chain D is seeded with the session and reaches the cloud.
	const session = tests.some(entry => entry.deepPrevious || entry.deepLegacy || entry.deepOlder || entry.dragout)
	// Spike s7 signs in through the 4.x form on its own.
	let logins =
		(session ? SESSION_SLOTS : 0) +
		tests.reduce(
			(sum, entry) =>
				sum +
				Number(entry.signInPrevious === "real") +
				Number(entry.signInLegacy === "real") +
				Number(entry.signInOlder === "real") +
				Number(entry.spike === "s7"),
			0
		)
	// The cloud-full check's one sign-in on the quota account, where the run has room for it.
	const quota = tests.find(entry => spike === "" && entry.deepPrevious && idOf(entry) === QUOTA_ENTRY)

	if (quota !== undefined && logins < MAX_LOGINS_PER_RUN) {
		quota.quota = true
		logins++
	} else if (quota !== undefined) {
		notices.push(
			`The cloud-storage-full check is skipped: the run's sign-ins are at MAX_LOGINS_PER_RUN (${String(MAX_LOGINS_PER_RUN)}).`
		)
	}

	if (logins > MAX_LOGINS_PER_RUN) {
		invalid(
			`the run could log in ${String(logins)} times, more than MAX_LOGINS_PER_RUN (${String(MAX_LOGINS_PER_RUN)}): name fewer formats or sign in with auto`
		)
	}

	const pins = [
		...(tests.some(entry => entry.deepLegacy) ? [LEGACY_PIN.version] : []),
		...(tests.some(entry => entry.deepOlder) ? [OLDER_PIN.version] : [])
	].join(",")

	return { profile, spike, session, logins, pins, builds, tests, notices }
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
			pins: result.pins,
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
