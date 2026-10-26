import { appendFileSync, readFileSync } from "node:fs"

// Plans .github/workflows/install-test-desktop.yml: the candidate version N (package.json), the lower version N-1 is
// built as, and the build and test matrices for the requested platforms. Written to $GITHUB_OUTPUT when set.
//
//   PLATFORMS=windows,mac,linux SIGNED=true|false node scripts/ci/installTestPlan.ts

type Os = "windows" | "mac" | "linux"

interface TestEntry {
	os: Os
	platform: "win" | "mac" | "linux"
	arch: "x64" | "arm64"
	format: "nsis" | "dmg" | "deb" | "rpm" | "AppImage"
	runner: string
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

const tests: TestEntry[] = [
	{ os: "windows", platform: "win", arch: "x64", format: "nsis", runner: "windows-latest" },
	{ os: "windows", platform: "win", arch: "arm64", format: "nsis", runner: "windows-11-arm" },
	{ os: "mac", platform: "mac", arch: "arm64", format: "dmg", runner: "macos-26" },
	{ os: "mac", platform: "mac", arch: "x64", format: "dmg", runner: "macos-26-intel" },
	...(["x64", "arm64"] as const).flatMap(arch =>
		(["deb", "rpm", "AppImage"] as const).map((format): TestEntry => ({
			os: "linux",
			platform: "linux",
			arch,
			format,
			runner: arch === "x64" ? "ubuntu-24.04" : "ubuntu-24.04-arm"
		}))
	)
]

const builders: Record<Os, string> = { windows: "windows-latest", mac: "macos-26", linux: "ubuntu-latest" }

if (import.meta.main) {
	const requested = (process.env["PLATFORMS"] ?? "windows,mac,linux")
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry !== "")
	const unknown = requested.filter(entry => !Object.hasOwn(builders, entry))

	if (unknown.length > 0 || requested.length === 0) {
		console.error(`PLATFORMS must list some of windows, mac, linux (got "${requested.join(",")}")`)
		process.exit(1)
	}

	// Squirrel.Mac installs an update only if it satisfies the running app's designated requirement, which ad-hoc signed
	// builds never do, so unsigned runs leave macOS out.
	const signed = process.env["SIGNED"] !== "false"

	if (!signed && requested.includes("mac")) {
		console.log("::notice::macOS is not tested unsigned: Squirrel.Mac needs both builds signed by the same Developer ID.")
	}

	const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
	const oses = (Object.keys(builders) as Os[]).filter(os => requested.includes(os) && (signed || os !== "mac"))

	if (oses.length === 0) {
		console.error("nothing to test")
		process.exit(1)
	}

	const outputs = {
		"next-version": version,
		"prev-version": previousVersion(version),
		"build-matrix": JSON.stringify({ include: oses.map(os => ({ os, runner: builders[os] })) }),
		"test-matrix": JSON.stringify({ include: tests.filter(entry => oses.includes(entry.os)) })
	}

	for (const [key, value] of Object.entries(outputs)) {
		console.log(`${key}=${value}`)

		if (process.env["GITHUB_OUTPUT"]) {
			appendFileSync(process.env["GITHUB_OUTPUT"], `${key}=${value}\n`)
		}
	}
}
