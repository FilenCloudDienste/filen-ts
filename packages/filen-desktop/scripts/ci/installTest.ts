import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { hashFile, parseFeed } from "../feed.ts"
import { LEGACY_E2E_BANNER, LEGACY_RELEASE_URL, LEGACY_SHA512, LEGACY_VERSION } from "./legacy.ts"
import {
	downloadPinned,
	errorMessage,
	fail,
	holds,
	section,
	serveFeed,
	startXvfb,
	TestFailure,
	waitFor,
	type FeedServer
} from "./support.ts"
import { targetFor, type AppProcess, type Arch, type Format, type Platform, type Target } from "./targets.ts"

// Real-install test of one format on a runner of its platform and architecture (see
// .github/workflows/install-test-desktop.yml). An app is installed the way a user installs it, launched, and updated by
// its own updater from a feed on the loopback interface that serves the candidate build N; the test then holds the
// relaunched app to N's version, at the same install location, with the same userData and a marker file in it intact.
//
//   previous   the installed app is N-1, a build of the same commit with a lower version
//   legacy     the installed app is the real 3.0.53 release, the version the whole fleet updates from
//
//   node scripts/ci/installTest.ts --scenario <previous|legacy> --platform <win|mac|linux> --arch <x64|arm64>
//       --format <nsis|dmg|deb|rpm|AppImage> --next <dir> --next-version <v> [--prev <dir> --prev-version <v>] [--signed]
//
// The new app's side of the contract (src/main): FILEN_DESKTOP_TEST_UPDATE_FEED, honoured only as plain http on
// 127.0.0.1, replaces the feed and installs a downloaded update at once, through the same path as the page's restart
// prompt; it logs TEST_FEED_LOG when it takes effect. Every launch logs "Filen <version> starting" to
// <userData>/logs/main.log, which is how the relaunched version is read without touching the app.

const TEST_FEED_ENV = "FILEN_DESKTOP_TEST_UPDATE_FEED"
const TEST_FEED_LOG = "updater: test feed"
const MARKER = "install-test.marker"

const START_TIMEOUT_MS = 3 * 60 * 1000
// Download, Squirrel staging or the installer, the swap and the relaunch; the 3.x NSIS update also runs WinFSP's MSI.
const UPDATE_TIMEOUT_MS = 25 * 60 * 1000
const EXIT_TIMEOUT_MS = 2 * 60 * 1000
const ALIVE_MS = 20 * 1000

const { values } = parseArgs({
	options: {
		scenario: { type: "string" },
		platform: { type: "string" },
		arch: { type: "string" },
		format: { type: "string" },
		next: { type: "string" },
		"next-version": { type: "string" },
		prev: { type: "string" },
		"prev-version": { type: "string" },
		signed: { type: "boolean", default: false },
		work: { type: "string", default: path.join(os.tmpdir(), "filen-install-test") }
	}
})

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T {
	const match = allowed.find(candidate => candidate === value)

	if (match === undefined) {
		console.error(`--${name} must be one of ${allowed.join(", ")}`)
		process.exit(2)
	}

	return match
}

function required(name: string, value: string | undefined): string {
	if (value === undefined || value === "") {
		console.error(`--${name} is required`)
		process.exit(2)
	}

	return value
}

const scenario = oneOf("scenario", values.scenario, ["previous", "legacy"] as const)
const platform = oneOf<Platform>("platform", values.platform, ["win", "mac", "linux"])
const arch = oneOf<Arch>("arch", values.arch, ["x64", "arm64"])
const format = oneOf<Format>("format", values.format, ["nsis", "dmg", "deb", "rpm", "AppImage"])
const nextDir = path.resolve(required("next", values.next))
const nextVersion = required("next-version", values["next-version"])
const signed = values.signed
const work = path.resolve(values.work)

if (process.platform !== { win: "win32", mac: "darwin", linux: "linux" }[platform]) {
	console.error(`--platform ${platform} does not match this runner (${process.platform})`)
	process.exit(2)
}

// rpm/deb/AppImage versions turn a prerelease's "-" into "~" or "_"; the comparison is over the same characters.
function sameVersion(a: string, b: string): boolean {
	const normalise = (version: string) => version.trim().replace(/[~_-]/g, ".")

	return normalise(a) === normalise(b)
}

function samePath(a: string, b: string): boolean {
	return platform === "win" ? a.toLowerCase() === b.toLowerCase() : a === b
}

// The versions every launch logged, oldest first (the shell's log rotates into main.1.log).
function startedVersions(target: Target): string[] {
	const directory = path.join(target.userData, "logs")
	const text = ["main.1.log", "main.log"]
		.map(name => path.join(directory, name))
		.filter(file => existsSync(file))
		.map(file => readFileSync(file, "utf8"))
		.join("")

	return [...text.matchAll(/ INFO Filen (\S+) starting \(/g)].map(match => match[1] ?? "")
}

function logHas(file: string, needle: string): boolean {
	return existsSync(file) && readFileSync(file, "utf8").includes(needle)
}

function tail(file: string, lines = 60): string {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-lines).join("\n") : `(${file} does not exist)`
}

async function feedFor(target: Target): Promise<{ server: FeedServer; size: number; sha512: string }> {
	const manifestPath = path.join(nextDir, target.manifest)

	if (!existsSync(manifestPath)) {
		fail(`${manifestPath} is missing`)
	}

	const feed = parseFeed(readFileSync(manifestPath, "utf8"), target.manifest)

	if (feed.top.get("version") !== nextVersion) {
		fail(`${target.manifest} offers ${feed.top.get("version") ?? "no version"}, expected ${nextVersion}`)
	}

	const entry = feed.files.find(file => file.url === target.updateFile)

	if (!entry) {
		fail(`${target.manifest} does not list ${target.updateFile}, the file this install downloads`)
	}

	// Every listed file that exists, so the updater's own selection runs against the real manifest.
	const names = [target.manifest, ...feed.files.map(file => file.url).filter(url => existsSync(path.join(nextDir, url)))]
	const server = await serveFeed(nextDir, names)

	console.log(`feed ${server.url} serving ${names.join(", ")}`)

	return { server, size: entry.size, sha512: entry.sha512 }
}

function writeMarker(target: Target): string {
	const token = randomUUID()

	mkdirSync(target.userData, { recursive: true })
	writeFileSync(path.join(target.userData, MARKER), token)

	return token
}

function processesAt(target: Target): AppProcess[] {
	return target.mainProcesses().filter(entry => samePath(entry.path, target.executable))
}

function installFrom(target: Target, artifact: string, version: string, payloadSigned: boolean): void {
	section(`install ${path.basename(artifact)} (${version})`)
	target.reset()
	target.install(artifact)
	target.verifyInstall(payloadSigned)

	const installed = target.installedVersion()

	if (!sameVersion(installed, version)) {
		fail(`the installed app is ${installed}, expected ${version}`)
	}

	const registered = target.registeredVersion()

	if (registered !== null && !sameVersion(registered, version)) {
		fail(`the package database / uninstall entry records ${registered}, expected ${version}`)
	}
}

async function main(): Promise<void> {
	const target = targetFor(platform, arch, format)
	const legacy = scenario === "legacy"
	const fromVersion = legacy ? LEGACY_VERSION : required("prev-version", values["prev-version"])

	if (legacy && platform === "mac" && !signed) {
		// Squirrel.Mac installs an update only if it satisfies the running app's designated requirement, which 3.0.53
		// pins to Developer ID Team 7YTW5D2K7P. An unsigned candidate is (correctly) refused, so there is nothing to test.
		console.log(
			"::notice::3.0.53 -> candidate skipped on macOS: unsigned builds cannot satisfy the installed app's designated requirement (run with signed builds)"
		)

		return
	}

	if (platform === "mac" && !signed) {
		// Ad-hoc signatures differ per build, so N-1's designated requirement (its cdhash) never matches N.
		console.log(
			"::notice::N-1 -> N skipped on macOS: Squirrel.Mac needs both builds signed by the same Developer ID (run with signed builds)"
		)

		return
	}

	if (platform === "linux" && format !== "rpm" && process.getuid?.() !== 0) {
		// electron-updater asks for root with the first of these it finds; without a desktop session none can prompt.
		// Hidden, it falls back to sudo, which the runner grants without a password, and its non-root path still runs.
		for (const prompt of ["gksudo", "kdesudo", "pkexec", "beesu"]) {
			const found = (process.env["PATH"] ?? "").split(path.delimiter).some(dir => existsSync(path.join(dir, prompt)))

			if (found) {
				fail(`${prompt} is on PATH: hide it so the updater falls back to sudo (see install-test-desktop.yml)`)
			}
		}
	}

	let installer: string

	if (legacy) {
		const pinned = LEGACY_SHA512[target.installer]

		if (pinned === undefined) {
			fail(`no pinned 3.0.53 hash for ${target.installer}`)
		}

		installer = path.join(work, "legacy", target.installer)
		await downloadPinned(`${LEGACY_RELEASE_URL}${target.installer}`, installer, pinned)
	} else {
		installer = path.join(path.resolve(required("prev", values.prev)), target.installer)
	}

	const xvfb = platform === "linux" ? await startXvfb() : null
	let feed: FeedServer | null = null

	try {
		// 3.0.53 is a signed release on Windows and macOS.
		installFrom(target, installer, fromVersion, legacy ? platform !== "linux" : signed)

		const token = writeMarker(target)
		const served = await feedFor(target)

		feed = served.server

		section(`launch ${fromVersion} against the local feed`)

		const env: NodeJS.ProcessEnv = { ...process.env, [TEST_FEED_ENV]: feed.url }

		if (legacy) {
			mkdirSync(work, { recursive: true })
			Object.assign(env, {
				FILEN_E2E_UPDATER: "1",
				FILEN_E2E_UPDATE_FEED: feed.url,
				FILEN_E2E_ONCE_FILE: path.join(work, `once-${randomUUID()}`)
			})
		}

		target.launch(env)

		// The override must be provably in effect early; otherwise the app polls the real feed for the whole timeout.
		if (legacy) {
			const legacyLog = path.join(path.dirname(target.userData), "logs", "desktop.log")

			await waitFor("3.0.53 to log its E2E updater banner", START_TIMEOUT_MS, () =>
				logHas(legacyLog, LEGACY_E2E_BANNER) ? true : null
			)
		} else {
			const mainLog = path.join(target.userData, "logs", "main.log")

			await waitFor(`${fromVersion} to start`, START_TIMEOUT_MS, () => (startedVersions(target).includes(fromVersion) ? true : null))
			await waitFor(`${fromVersion} to take the test feed`, START_TIMEOUT_MS, () => (logHas(mainLog, TEST_FEED_LOG) ? true : null))
		}

		const before = await waitFor(`${fromVersion}'s main process`, START_TIMEOUT_MS, () => {
			const found = processesAt(target)

			return found.length > 0 ? found : null
		})
		const userDataBefore = readdirSync(target.userData).sort()

		console.log(`running ${fromVersion}: pid ${before.map(entry => String(entry.pid)).join(", ")} at ${target.executable}`)

		section(`update ${fromVersion} -> ${nextVersion}`)
		await waitFor(
			`the relaunched app to log "Filen ${nextVersion} starting"`,
			UPDATE_TIMEOUT_MS,
			() => (startedVersions(target).some(version => sameVersion(version, nextVersion)) ? true : null),
			5000
		)

		const oldPids = new Set(before.map(entry => entry.pid))

		await waitFor(`${fromVersion}'s process to exit`, EXIT_TIMEOUT_MS, () =>
			target.mainProcesses().some(entry => oldPids.has(entry.pid)) ? null : true
		)

		const after = await waitFor(`${nextVersion}'s main process at ${target.executable}`, EXIT_TIMEOUT_MS, () => {
			const found = processesAt(target).filter(entry => !oldPids.has(entry.pid))

			return found.length > 0 ? found : null
		})
		const pids = new Set(after.map(entry => entry.pid))

		console.log(`relaunched: pid ${[...pids].join(", ")}`)
		await holds(`${nextVersion} running from ${target.executable}`, ALIVE_MS, () =>
			processesAt(target).some(entry => pids.has(entry.pid))
		)

		section("verify")
		target.verifyInstall(signed)

		const installed = target.installedVersion()

		if (!sameVersion(installed, nextVersion)) {
			fail(`the installed app is ${installed} after the update, expected ${nextVersion}`)
		}

		const registered = target.registeredVersion()

		if (registered !== null && !sameVersion(registered, nextVersion)) {
			fail(`the package database / uninstall entry records ${registered} after the update, expected ${nextVersion}`)
		}

		const marker = path.join(target.userData, MARKER)

		if (!existsSync(marker) || readFileSync(marker, "utf8") !== token) {
			fail(`${marker} did not survive the update: userData was removed or replaced`)
		}

		// One log, both versions: the new app started on the very userData the old one used.
		if (!legacy) {
			const versions = startedVersions(target)
			const from = versions.indexOf(fromVersion)
			const to = versions.findIndex(version => sameVersion(version, nextVersion))

			if (from === -1 || to < from) {
				fail(`main.log does not show ${fromVersion} and then ${nextVersion} starting: [${versions.join(", ")}]`)
			}
		}

		const download = feed.requests.find(request => request.path === target.updateFile && request.status === 200)

		if (!download || download.bytes !== served.size) {
			fail(`${target.updateFile} was not downloaded in full from the feed (expected ${String(served.size)} bytes)`)
		}

		const strays = feed.requests.filter(
			request => request.status === 200 && request.path !== target.updateFile && !request.path.endsWith(".yml")
		)

		if (strays.length > 0) {
			fail(
				`the updater also downloaded ${strays.map(request => request.path).join(", ")}: it selected a file this install should not use`
			)
		}

		// The AppImage update replaces the file in place.
		if (format === "AppImage" && (await hashFile(target.executable))?.sha512 !== served.sha512) {
			fail(`${target.executable} is not the AppImage the feed served`)
		}

		if (legacy) {
			const userDataAfter = new Set(readdirSync(target.userData))
			const gone = userDataBefore.filter(entry => !userDataAfter.has(entry))
			const migration = path.join(target.userData, "migration.json")

			// Informational: the 4.x migration removes some of 3.x's stores by design (PLAN §6).
			console.log(`userData entries 3.0.53 had that are gone now: ${gone.length > 0 ? gone.join(", ") : "none"}`)
			console.log(`migration marker: ${existsSync(migration) ? readFileSync(migration, "utf8") : "absent"}`)
		}

		console.log(`\n${scenario}: ${fromVersion} -> ${nextVersion} on ${platform} ${arch} ${format} PASSED`)
	} catch (error) {
		section("diagnostics")
		console.log(`--- ${target.userData}/logs/main.log`)
		console.log(tail(path.join(target.userData, "logs", "main.log")))

		if (legacy) {
			const legacyLog = path.join(path.dirname(target.userData), "logs", "desktop.log")

			console.log(`--- ${legacyLog}`)
			console.log(tail(legacyLog))
		}

		console.log("--- feed requests")
		console.log(
			feed?.requests.map(request => `${String(request.status)} ${request.path} ${String(request.bytes)}`).join("\n") ?? "(no feed)"
		)
		console.log("--- main processes")

		try {
			console.log(
				target
					.mainProcesses()
					.map(entry => `${String(entry.pid)} ${entry.path}`)
					.join("\n") || "(none)"
			)
		} catch (listing) {
			console.log(errorMessage(listing))
		}

		throw error
	} finally {
		try {
			target.reset()
		} catch (error) {
			console.log(`cleanup: ${errorMessage(error)}`)
		}

		await feed?.close()
		xvfb?.kill()
	}
}

try {
	await main()
} catch (error) {
	console.error(
		`::error::${scenario} ${platform} ${arch} ${format}: ${error instanceof TestFailure ? error.message : errorMessage(error)}`
	)
	process.exit(1)
}
