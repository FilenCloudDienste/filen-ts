import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hashFile, parseFeed } from "../../feed.ts"
import { nativeArchOf } from "../../nativeArch.ts"
import { LEGACY_E2E_BANNER, LEGACY_RELEASE_URL, LEGACY_SHA512, LEGACY_VERSION } from "../legacy.ts"
import { downloadPinned, errorMessage, fail, holds, run, section, serveFeed, startXvfb, waitFor, type FeedServer } from "../support.ts"
import { linuxProcessReport, type AppProcess, type Arch, type Format, type Platform, type Target } from "../targets.ts"

// The update scenarios: an app is installed the way a user installs it, launched, and updated by its own updater from a
// feed on the loopback interface that serves the candidate build N; the test then holds the relaunched app to N's
// version, at the same install location, with the same userData and a marker file in it intact.
//
//   previous   the installed app is N-1, a build of the same commit with a lower version
//   legacy     the installed app is the real 3.0.53 release, the version the whole fleet updates from
//
// The new app's side of the contract (src/main): FILEN_DESKTOP_TEST_UPDATE_FEED, honoured only as plain http on
// 127.0.0.1, replaces the feed and installs a downloaded update at once, through the same path as the page's restart
// prompt; it logs TEST_FEED_LOG when it takes effect. Every launch logs "Filen <version> starting" to
// <userData>/logs/main.log, which is how the relaunched version is read without touching the app.
//
// The updated app must also ship the pinned rclone (build/rclone/versions.json) for its CPU, runnable from the install,
// and on Windows have WinFsp installed (Target.verifyInstall).

const TEST_FEED_ENV = "FILEN_DESKTOP_TEST_UPDATE_FEED"
const TEST_FEED_LOG = "updater: test feed"
const MARKER = "e2e.marker"

export const START_TIMEOUT_MS = 3 * 60 * 1000
// Download, Squirrel staging or the installer, the swap and the relaunch; the 3.x NSIS update also runs WinFSP's MSI.
const UPDATE_TIMEOUT_MS = 25 * 60 * 1000
const EXIT_TIMEOUT_MS = 2 * 60 * 1000
const ALIVE_MS = 20 * 1000

export interface UpdateOptions {
	scenario: "previous" | "legacy"
	target: Target
	platform: Platform
	arch: Arch
	format: Format
	nextDir: string
	nextVersion: string
	// Both set for "previous".
	prevDir: string | null
	prevVersion: string | null
	signed: boolean
	work: string
}

// rpm/deb/AppImage versions turn a prerelease's "-" into "~" or "_"; the comparison is over the same characters.
export function sameVersion(a: string, b: string): boolean {
	const normalise = (version: string) => version.trim().replace(/[~_-]/g, ".")

	return normalise(a) === normalise(b)
}

// The versions every launch logged, oldest first (the shell's log rotates into main.1.log).
export function startedVersions(target: Target): string[] {
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

export function tail(file: string, lines = 60): string {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-lines).join("\n") : `(${file} does not exist)`
}

// 3.x logs to <appData>/@filen/logs, next to its userData.
export function legacyLogOf(target: Target): string {
	return path.join(path.dirname(target.userData), "logs", "desktop.log")
}

async function feedFor(
	target: Target,
	nextDir: string,
	nextVersion: string
): Promise<{ server: FeedServer; size: number; sha512: string }> {
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

// The installed app's rclone: built for the runner's CPU and the pinned release.
function verifyRclone(target: Target, arch: Arch): void {
	const versions: unknown = JSON.parse(
		readFileSync(fileURLToPath(new URL("../../../build/rclone/versions.json", import.meta.url)), "utf8")
	)
	const pinned = typeof versions === "object" && versions !== null && "rclone" in versions ? versions.rclone : undefined

	if (typeof pinned !== "string") {
		fail("build/rclone/versions.json names no rclone version")
	}

	target.resource(path.join("rclone", target.platform === "win" ? "rclone.exe" : "rclone"), file => {
		if (!existsSync(file)) {
			fail(`${file} is missing`)
		}

		const found = nativeArchOf(file)

		if (found !== arch) {
			fail(`${file} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		const version = /^rclone v(\S+)$/m.exec(run(file, ["version"]).stdout)?.[1]

		if (version !== pinned) {
			fail(`${file} is rclone ${version ?? "of no version"}, expected ${pinned}`)
		}
	})
}

function writeMarker(target: Target): string {
	const token = randomUUID()

	mkdirSync(target.userData, { recursive: true })
	writeFileSync(path.join(target.userData, MARKER), token)

	return token
}

function processesAt(target: Target): AppProcess[] {
	const samePath = (a: string, b: string) => (target.platform === "win" ? a.toLowerCase() === b.toLowerCase() : a === b)

	return target.mainProcesses().filter(entry => samePath(entry.path, target.executable))
}

export function installFrom(target: Target, artifact: string, version: string, payloadSigned: boolean): void {
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

// The pinned 3.0.53 installer for this target, downloaded into `work` and checked against its release hash.
export async function legacyInstaller(target: Target, work: string): Promise<string> {
	const pinned = LEGACY_SHA512[target.installer]

	if (pinned === undefined) {
		fail(`no pinned 3.0.53 hash for ${target.installer}`)
	}

	const installer = path.join(work, "legacy", target.installer)

	await downloadPinned(`${LEGACY_RELEASE_URL}${target.installer}`, installer, pinned)

	return installer
}

export async function runUpdate({
	scenario,
	target,
	platform,
	arch,
	format,
	nextDir,
	nextVersion,
	prevDir,
	prevVersion,
	signed,
	work
}: UpdateOptions): Promise<void> {
	const legacy = scenario === "legacy"
	const fromVersion = legacy ? LEGACY_VERSION : (prevVersion ?? fail("--prev-version is required"))

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
				fail(`${prompt} is on PATH: hide it so the updater falls back to sudo (see desktop-e2e.yml)`)
			}
		}
	}

	const installer = legacy ? await legacyInstaller(target, work) : path.join(prevDir ?? fail("--prev is required"), target.installer)
	const xvfb = platform === "linux" ? await startXvfb() : null
	let feed: FeedServer | null = null

	try {
		// 3.0.53 is a signed release on Windows and macOS.
		installFrom(target, installer, fromVersion, legacy ? platform !== "linux" : signed)

		const token = writeMarker(target)
		const served = await feedFor(target, nextDir, nextVersion)

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
			const legacyLog = legacyLogOf(target)

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
		verifyRclone(target, arch)

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
			const legacyLog = legacyLogOf(target)

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

		if (platform === "linux") {
			console.log("--- Filen and AppImage processes")
			console.log(linuxProcessReport())
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
