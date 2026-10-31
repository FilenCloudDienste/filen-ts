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
//   SPIKE       none | s1 | s7: a dispatch-only spike instead of the update scenarios
//
//   node scripts/ci/e2ePlan.ts

export type Os = "windows" | "mac" | "linux"
export type Profile = "release" | "nightly" | "custom"
export type Spike = "s1" | "s7"

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
	spike: string
}

export interface Plan {
	profile: Profile
	spike: Spike | ""
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

// One entry per OS, on the format each spike asks about.
const spikeEntries: Record<Spike, readonly string[]> = {
	s1: ["win-x64-nsis", "mac-arm64-dmg", "linux-x64-deb"],
	s7: ["mac-arm64-dmg"]
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

export function plan(input: PlanInput): Plan {
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
	const spike = (["", "s1", "s7"] as const).find(candidate => candidate === spikeName)

	if (spike === undefined) {
		invalid(`SPIKE must be none, s1 or s7 (got "${input.spike}")`)
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

	const tests = chosen.map((entry): TestEntry => ({
		...entry,
		signed: sign[entry.os],
		previous,
		legacy,
		spike
	}))
	const builds = (Object.keys(builders) as Os[])
		.filter(os => tests.some(entry => entry.os === os))
		.map((os): BuildEntry => ({ os, runner: builders[os], sign: sign[os] }))

	return { profile, spike, builds, tests, notices }
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
			spike: env("SPIKE")
		})

		for (const notice of result.notices) {
			console.log(`::notice::${notice}`)
		}

		const outputs = {
			profile: result.profile,
			spike: result.spike,
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
