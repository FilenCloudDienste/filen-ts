import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { hashFile, parseFeed } from "../../feed.ts"
import { nativeArchOf } from "../../nativeArch.ts"
import { LEGACY_E2E_BANNER, LEGACY_PIN, pinFor, type LegacyPin } from "../legacy.ts"
import {
	downloadPinned,
	errorMessage,
	fail,
	holds,
	run,
	seconds,
	section,
	serveFeed,
	startXvfb,
	waitFor,
	type FeedFaultPlan,
	type FeedServer
} from "../support.ts"
import { linuxProcessReport, type AppProcess, type Arch, type Format, type Platform, type Target } from "../targets.ts"
import type { Findings } from "./findings.ts"
import { legacyUpdateHook } from "./legacyHook.ts"
import { installedBy, updateEnvFor, verifyLegacyLink } from "./olderUpdate.ts"
import { finishUpdateWizard } from "./windows.ts"
import { installerProcesses, logMark, logSince, runFaultLaunch } from "./updateFaults.ts"

// The update scenarios: an app is installed the way a user installs it, launched, and updated by its own updater from a
// feed on the loopback interface that serves the candidate build N; the test then holds the relaunched app to N's
// version, at the same install location, with the same userData and a marker file in it intact.
//
//   previous   the installed app is N-1, a build of the same commit with a lower version
//   legacy     the installed app is the real 3.0.53 release, the version the whole fleet updates from
//   older      the installed app is the real 3.0.47 release (scripts/ci/legacy.ts OLDER_PIN): no E2E hook, so its
//              update launch is hooked through its inspector (scripts/ci/e2e/legacyHook.ts); on Linux it runs as
//              /opt/Filen/@filendesktop, which its updater relaunches, so N must come back through 4.x's link there
//
// The new app's side of the contract (src/main): FILEN_DESKTOP_TEST_UPDATE_FEED, honoured only as plain http on
// 127.0.0.1, replaces the feed and installs a downloaded update at once, through the same path as the page's restart
// prompt; it logs TEST_FEED_LOG when it takes effect. Every launch logs "Filen <version> starting" to
// <userData>/logs/main.log, which is how the relaunched version is read without touching the app.
//
// The updated app must also ship the pinned rclone (build/rclone/versions.json) for its CPU, runnable from the install,
// and on Windows have WinFsp installed (Target.verifyInstall).

export const TEST_FEED_ENV = "FILEN_DESKTOP_TEST_UPDATE_FEED"
export const TEST_FEED_LOG = "updater: test feed"
export const MARKER = "e2e.marker"

export const START_TIMEOUT_MS = 3 * 60 * 1000
// Download, Squirrel staging or the installer, the swap and the relaunch; the 3.x NSIS update also runs WinFSP's MSI.
const UPDATE_TIMEOUT_MS = 25 * 60 * 1000
// From the old app's update launch settling, or from the download's last progress, to a sign that its install started
// (INSTALL_SIGNS): the download from the loopback feed and its verification, or Squirrel.Mac's staging.
export const INSTALL_START_TIMEOUT_MS = 5 * 60 * 1000
// How long the old app may be gone with no sign of an install before the wait ends: an app that quits to install hands
// over to its installer within seconds, and logs that the update was downloaded before it quits.
export const GONE_GRACE_MS = 60 * 1000
const EXIT_TIMEOUT_MS = 2 * 60 * 1000
const ALIVE_MS = 20 * 1000

export interface UpdateOptions {
	scenario: "previous" | "legacy" | "older"
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
	// The deep chains' own steps around the update.
	hooks?: UpdateHooks
}

export interface UpdateHooks {
	// Once the installed app is ready, before its update launch; the app must not be running when it returns.
	beforeUpdate(): Promise<void>
	// Once the update is verified, with N running as the updater relaunched it, before the machine is reset.
	afterUpdate(): Promise<void>
	// Whatever happened, before the machine is reset (evidence that lives in userData).
	beforeReset(): Promise<void>
	// Extra arguments for the update launch, and what to do once it is started (before the update is waited for).
	// `feed` is the loopback feed, which a release without an E2E hook must be pointed at by the hook itself.
	updateLaunch?(feed: string): Promise<{ args: string[]; started(): Promise<void> }>
	// The fault launch (e2e/updateFaults.ts): where its checks go (a deep chain's findings; else its own, settled after
	// the update), and how N-1 is ended during its stalled download (a graceful quit; else a hard kill).
	findings?: Findings
	stopFaultLaunch?(pids: readonly number[]): Promise<void>
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

// What the old app logs once its update is downloaded or being installed: 3.x's own lines in desktop.log, and
// electron-updater's in 4.x's main.log (through its "updater: " logger).
export const INSTALL_SIGNS = {
	legacy: ["Update downloaded", "Installing update"],
	current: ["has been downloaded to", "Install: isSilent", "Install on explicit quitAndInstall", "Auto install update on quit"]
} as const

export interface InstallProbe {
	// The old app's log since its update launch, and what in it shows the install started.
	log(): string
	needles: readonly string[]
	// Processes installing an update (updateFaults.ts installerProcesses), as "pid command line".
	installers(): Promise<string[]>
	// Null where reading it is no cheap look (an AppImage's is extracted by running the file the update replaces).
	installedVersion: (() => string) | null
	startedVersions(): string[]
}

// Every sign that the old app started installing the update; none yet: empty. Downloading the file alone is none: the
// app can die after it, as 3.0.53 did on Windows arm64.
export async function installSigns(probe: InstallProbe, fromVersion: string, nextVersion: string): Promise<string[]> {
	const log = probe.log()
	const signs = probe.needles.filter(needle => log.includes(needle)).map(needle => `logged "${needle}"`)

	try {
		signs.push(...(await probe.installers()).map(line => `an installer runs: ${line}`))
	} catch (error) {
		console.log(`listing installer processes: ${errorMessage(error)}`)
	}

	try {
		const installed = probe.installedVersion?.() ?? fromVersion

		if (!sameVersion(installed, fromVersion)) {
			signs.push(`the installed app is ${installed}`)
		}
	} catch (error) {
		// Mid-install, the files can be gone for a moment.
		console.log(`reading the installed version: ${errorMessage(error)}`)
	}

	if (probe.startedVersions().some(version => sameVersion(version, nextVersion))) {
		signs.push(`${nextVersion} started`)
	}

	return signs
}

// The install-start wait at `now` (installSigns found none yet): null while it goes on; else why it ends. The window runs
// from the launch settling (`startedAt`) or the download's last progress, whichever is later, so a download still
// advancing is waited for; an old app gone (`goneAt`, its main process no longer seen) ends it once GONE_GRACE_MS passed.
export function installStartEnd(
	now: number,
	startedAt: number,
	progressAt: number | null,
	goneAt: number | null
): { kind: "gone"; sinceMs: number } | { kind: "stalled"; sinceMs: number } | null {
	if (goneAt !== null && now - goneAt >= GONE_GRACE_MS) {
		return { kind: "gone", sinceMs: now - goneAt }
	}

	const from = Math.max(startedAt, progressAt ?? startedAt)

	return now - from >= INSTALL_START_TIMEOUT_MS ? { kind: "stalled", sinceMs: now - from } : null
}

// How a launched process ended: Windows' exit codes are NTSTATUS values (0xC0000005 an access violation), shown in hex.
export function describeExit(exit: { code: number | null; signal: string | null } | null): string {
	if (exit === null) {
		return "its launched process still running or its end not seen"
	}

	if (exit.code === null) {
		return `ended by ${exit.signal ?? "an unknown signal"}`
	}

	return exit.code > 0xffff
		? `exit code ${String(exit.code)} (0x${exit.code.toString(16).toUpperCase()})`
		: `exit code ${String(exit.code)}`
}

// A main-process listing, entries without a readable executable path included.
export function describeProcesses(list: readonly AppProcess[]): string {
	return list.map(entry => `${String(entry.pid)} ${entry.path === "" ? "(no path)" : entry.path}`).join(", ") || "no main process"
}

// `file` past its first `offset` bytes (all of it once it shrank).
export function textFrom(file: string, offset: number): string {
	if (!existsSync(file)) {
		return ""
	}

	const content = readFileSync(file)

	return (content.length < offset ? content : content.subarray(offset)).toString("utf8")
}

export function tail(file: string, lines = 60): string {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-lines).join("\n") : `(${file} does not exist)`
}

// 3.x logs to <appData>/@filen/logs, next to its userData.
export function legacyLogOf(target: Target): string {
	return path.join(path.dirname(target.userData), "logs", "desktop.log")
}

// The update launch of a release without an E2E hook: its updater pointed at `feed`, and what it downloads installed.
async function hookedUpdateLaunch(
	feed: string,
	version: string,
	relaunchAs: string
): Promise<{ args: string[]; started(): Promise<void> }> {
	const hook = await legacyUpdateHook({ holdSync: false, feed, relaunchAs })

	return {
		args: hook.args,
		started: async () => {
			const state = await hook.started()

			console.log(
				`${version}'s updater hooked: feed ${String(state.feed)}, install on download ${String(state.updater)}, worker threads without the inspector ${String(state.threads)}, relaunch without it ${String(state.relaunch)}`
			)
		}
	}
}

export async function feedFor(
	target: Target,
	nextDir: string,
	nextVersion: string,
	plan?: FeedFaultPlan
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
	const server = await serveFeed(nextDir, names, plan)

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

export function writeMarker(target: Target): string {
	const token = randomUUID()

	mkdirSync(target.userData, { recursive: true })
	writeFileSync(path.join(target.userData, MARKER), token)

	return token
}

export function processesAt(target: Target): AppProcess[] {
	const samePath = (a: string, b: string) => (target.platform === "win" ? a.toLowerCase() === b.toLowerCase() : a === b)

	const all = target.mainProcesses()
	const unnamed = all.filter(entry => entry.path === "")

	if (unnamed.length > 0) {
		console.log(`main processes without a readable path (not counted): ${describeProcesses(unnamed)}`)
	}

	return all.filter(entry => samePath(entry.path, target.executable))
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

// The pinned old installer for this target (3.0.53 unless `pin` says otherwise), downloaded into `work` and checked
// against its release hash.
export async function legacyInstaller(target: Target, work: string, pin: LegacyPin = LEGACY_PIN): Promise<string> {
	const pinned = pin.sha512[target.installer]

	if (pinned === undefined) {
		fail(`no pinned ${pin.version} hash for ${target.installer}`)
	}

	const installer = path.join(work, "legacy", pin.version, target.installer)

	await downloadPinned(`${pin.releaseUrl}${target.installer}`, installer, pinned)

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
	work,
	hooks
}: UpdateOptions): Promise<void> {
	// The old release this update starts from (null: N-1), and the install as it left it (its own Linux executable).
	const pin = pinFor(scenario)
	const legacy = pin !== null
	const fromVersion = pin?.version ?? prevVersion ?? fail("--prev-version is required")
	const from = pin === null ? target : installedBy(target, pin)

	if (legacy && platform === "mac" && !signed) {
		// Squirrel.Mac installs an update only if it satisfies the running app's designated requirement, which 3.x
		// pins to Developer ID Team 7YTW5D2K7P. An unsigned candidate is (correctly) refused, so there is nothing to test.
		console.log(
			`::notice::${fromVersion} -> candidate skipped on macOS: unsigned builds cannot satisfy the installed app's designated requirement (run with signed builds)`
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

	const installer =
		pin !== null ? await legacyInstaller(target, work, pin) : path.join(prevDir ?? fail("--prev is required"), target.installer)
	const xvfb = platform === "linux" ? await startXvfb() : null
	// The update launch's stdout and stderr, kept as evidence.
	const output = path.join(work, `${scenario}-update-launch-output.log`)
	let feed: FeedServer | null = null

	try {
		// 3.x is a signed release on Windows and macOS.
		installFrom(from, installer, fromVersion, legacy ? platform !== "linux" : signed)

		const token = writeMarker(target)

		await hooks?.beforeUpdate()

		// N-1 against a feed that fails in every way first (plan D5); what follows reads main.log only past it.
		const settleFaults = legacy
			? () => undefined
			: await runFaultLaunch({
					target,
					nextDir,
					nextVersion,
					fromVersion,
					work,
					findings: hooks?.findings,
					stop: hooks?.stopFaultLaunch
				})
		const mark = logMark(target)
		const served = await feedFor(target, nextDir, nextVersion)

		feed = served.server

		section(`launch ${fromVersion} against the local feed`)

		let env: NodeJS.ProcessEnv = { ...process.env, [TEST_FEED_ENV]: feed.url }

		if (pin?.hasE2eHook === true) {
			mkdirSync(work, { recursive: true })
			Object.assign(env, {
				FILEN_E2E_UPDATER: "1",
				FILEN_E2E_UPDATE_FEED: feed.url,
				FILEN_E2E_ONCE_FILE: path.join(work, `once-${randomUUID()}`)
			})
		} else if (pin !== null) {
			env = updateEnvFor(target, pin, env, work)
		}

		// A release without an E2E hook gets one from outside when no chain hooks its launch (the chain does it itself).
		const updateLaunch =
			(await hooks?.updateLaunch?.(feed.url)) ??
			(pin !== null && !pin.hasE2eHook ? await hookedUpdateLaunch(feed.url, fromVersion, from.executable) : undefined)

		const legacyLog = legacyLogOf(target)
		const legacyMark = legacy && existsSync(legacyLog) ? statSync(legacyLog).size : 0

		mkdirSync(work, { recursive: true })

		const fd = openSync(output, "a", 0o600)
		const launchedAt = Date.now()
		// How the launched process (the old app's main process, or the runtime that starts it) ended, and when.
		const launchEnd: { exit: { code: number | null; signal: string | null; at: number } | null } = { exit: null }

		try {
			from.launch({ ...env, ELECTRON_ENABLE_LOGGING: "1" }, updateLaunch?.args ?? [], fd).once("exit", (code, signal) => {
				const exit = { code, signal, at: Date.now() }

				launchEnd.exit = exit
				console.log(`${fromVersion}'s update launch ended ${seconds(launchedAt, exit.at)} after it started: ${describeExit(exit)}`)
			})
		} finally {
			// The child holds its own copy.
			closeSync(fd)
		}

		await updateLaunch?.started()

		// The override must be provably in effect early; otherwise the app polls the real feed for the whole timeout.
		if (pin !== null && !pin.hasE2eHook) {
			await waitFor(`${fromVersion}'s updater to ask the local feed`, START_TIMEOUT_MS, () =>
				served.server.requests.some(request => request.path === target.manifest) ? true : null
			)
		} else if (legacy) {
			await waitFor(`${fromVersion} to log its E2E updater banner`, START_TIMEOUT_MS, () =>
				logHas(legacyLog, LEGACY_E2E_BANNER) ? true : null
			)
		} else {
			await waitFor(`${fromVersion} to start`, START_TIMEOUT_MS, () =>
				logSince(target, mark).includes(` INFO Filen ${fromVersion} starting (`) ? true : null
			)
			await waitFor(`${fromVersion} to take the test feed`, START_TIMEOUT_MS, () =>
				logSince(target, mark).includes(TEST_FEED_LOG) ? true : null
			)
		}

		// The old app running, or already gone because its updater fetched the whole update and quit to install it (a
		// fast start, as when nothing but the updater runs, can get there before the first look). Each look is kept for
		// the failure.
		const fetched = () =>
			served.server.requests.some(
				request => request.path === target.updateFile && request.status === 200 && request.bytes === served.size
			)
		// Every byte of the update file the feed has sent so far, over all requests.
		const sentBytes = () =>
			served.server.requests.filter(request => request.path === target.updateFile).reduce((sum, request) => sum + request.bytes, 0)
		let seen = "nothing looked at yet"
		const look = (): string => {
			seen = describeProcesses([...from.mainProcesses(), ...(from === target ? [] : target.mainProcesses())])
			console.log(`main processes: ${seen}`)

			return seen
		}
		const before = await waitFor(`${fromVersion}'s main process`, START_TIMEOUT_MS, () => {
			look()

			const found = processesAt(from)

			return found.length > 0 ? found : fetched() ? [] : null
		}).catch((error: unknown) => fail(`${errorMessage(error)}; last seen: ${seen}`))
		const userDataBefore = readdirSync(target.userData).sort()

		console.log(
			before.length > 0
				? `running ${fromVersion}: pid ${before.map(entry => String(entry.pid)).join(", ")} at ${from.executable}`
				: `${fromVersion} is gone after fetching the update`
		)

		section(`update ${fromVersion} -> ${nextVersion}`)

		// A fetched file is no proof the app quit to install it: before the long wait, the install must show it started.
		const oldLog = () => (legacy ? textFrom(legacyLog, legacyMark) : logSince(target, mark))
		const probe: InstallProbe = {
			log: oldLog,
			needles: legacy ? INSTALL_SIGNS.legacy : INSTALL_SIGNS.current,
			installers: () => installerProcesses(from),
			installedVersion: format === "AppImage" ? null : () => from.installedVersion(),
			startedVersions: () => startedVersions(target)
		}
		// Until a sign: the window runs from the download's last progress, and an old app gone with no sign ends it early.
		const waitStarted = Date.now()
		let sent = sentBytes()
		let progressAt: number | null = null
		let goneAt: number | null = null
		let signs: string[] = []

		for (;;) {
			signs = await installSigns(probe, fromVersion, nextVersion)

			const now = Date.now()
			const running = processesAt(from).length > 0

			console.log(
				`install signs: ${signs.join("; ") || "none"}; main processes: ${look()}; update bytes sent ${String(sentBytes())} of ${String(served.size)}`
			)

			if (signs.length > 0) {
				break
			}

			if (sentBytes() > sent) {
				sent = sentBytes()
				progressAt = now
			}

			goneAt = running ? null : (goneAt ?? now)

			const end = installStartEnd(now, waitStarted, progressAt, goneAt)

			if (end !== null) {
				const exit = launchEnd.exit
				const why =
					end.kind === "gone"
						? `${fromVersion} is gone (${describeExit(exit)}${exit === null ? "" : `, ${seconds(launchedAt, exit.at)} after its update launch`}) and nothing started installing within ${seconds(0, end.sinceMs)}`
						: `no sign that ${fromVersion} started installing the update within ${seconds(0, end.sinceMs)} of ${progressAt === null ? "its launch settling" : "the download's last progress"}`

				fail(
					`${why}: none of ${probe.needles.map(needle => `"${needle}"`).join(", ")} logged, no installer ran, ` +
						`the installed version unchanged; main processes: ${seen}; the update download ${fetched() ? "completed" : `did not complete (${String(sentBytes())} of ${String(served.size)} bytes sent)`}; ` +
						`output in ${path.basename(output)}; ${legacy ? "3.x's log" : "main.log"} ends:\n${oldLog().split("\n").slice(-20).join("\n")}`
				)
			}

			await sleep(5000)
		}

		console.log(`install started: ${signs.join("; ")}`)

		// An old release whose update ends on the installer's Finish page (LegacyPin.winUpdateWizard): Finish is clicked
		// as its user clicks it, with "Run Filen" as the installer left it; N starts only then.
		let wizard: string | null = platform === "win" && pin?.winUpdateWizard === true ? "not seen" : null
		const finishWizard = async (): Promise<void> => {
			const step = await finishUpdateWizard()

			if (step.kind === "page") {
				wizard = `on the page whose button reads "${step.button}"`
				console.log(`${fromVersion}'s update wizard: ${wizard}`)
			} else if (step.kind === "stuck") {
				wizard = `Finish did not close it: ${step.detail}`
				console.log(`${fromVersion}'s update wizard: ${wizard}`)
			} else if (step.kind === "finished") {
				wizard = `Finish clicked, "Run Filen" ${step.run}`
				console.log(`${fromVersion}'s update wizard: ${wizard} (${step.detail})`)
				hooks?.findings?.info(
					`${fromVersion}'s update waits on the installer's Finish page on Windows (LegacyPin.winUpdateWizard)`,
					`${wizard}; its quitAndInstall(false, true) runs the assisted installer not silent, which ignores --force-run`
				)
			}
		}

		await waitFor(
			`the relaunched app to log "Filen ${nextVersion} starting"`,
			UPDATE_TIMEOUT_MS,
			async () => {
				look()

				if (startedVersions(target).some(version => sameVersion(version, nextVersion))) {
					return true
				}

				if (wizard !== null && !wizard.startsWith("Finish clicked")) {
					await finishWizard()
				}

				return null
			},
			5000
		).catch((error: unknown) => fail(`${errorMessage(error)}${wizard === null ? "" : `; ${fromVersion}'s update wizard: ${wizard}`}`))

		if (wizard === "not seen") {
			console.log(`${fromVersion}'s update wizard: not seen; ${nextVersion} started without it`)
		}

		const oldPids = new Set(before.map(entry => entry.pid))

		await waitFor(`${fromVersion}'s process to exit`, EXIT_TIMEOUT_MS, () =>
			from.mainProcesses().some(entry => oldPids.has(entry.pid)) ? null : true
		)

		const after = await waitFor(`${nextVersion}'s main process at ${target.executable}`, EXIT_TIMEOUT_MS, () => {
			look()

			const found = processesAt(target).filter(entry => !oldPids.has(entry.pid))

			return found.length > 0 ? found : null
		}).catch((error: unknown) => fail(`${errorMessage(error)}; last seen: ${seen}`))
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

		// B4: a release whose Linux executable had another name relaunched N through it.
		if (pin !== null && from !== target) {
			console.log(`legacy executable: ${await verifyLegacyLink(target, pin, [...pids])}`)
		}

		if (legacy) {
			const userDataAfter = new Set(readdirSync(target.userData))
			const gone = userDataBefore.filter(entry => !userDataAfter.has(entry))
			const migration = path.join(target.userData, "migration.json")

			// Informational: the 4.x migration removes some of 3.x's stores by design (PLAN §6).
			console.log(`userData entries ${fromVersion} had that are gone now: ${gone.length > 0 ? gone.join(", ") : "none"}`)
			console.log(`migration marker: ${existsSync(migration) ? readFileSync(migration, "utf8") : "absent"}`)
		}

		await hooks?.afterUpdate()
		settleFaults()

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

		console.log(`--- ${output}`)
		console.log(tail(output, 200))

		console.log("--- feed requests")
		console.log(
			feed?.requests.map(request => `${String(request.status)} ${request.path} ${String(request.bytes)}`).join("\n") ?? "(no feed)"
		)
		console.log("--- main processes")

		try {
			console.log(describeProcesses([...from.mainProcesses(), ...(from === target ? [] : target.mainProcesses())]))
		} catch (listing) {
			console.log(errorMessage(listing))
		}

		if (platform === "linux") {
			console.log("--- Filen and AppImage processes")
			console.log(linuxProcessReport())
		}

		throw error
	} finally {
		await hooks?.beforeReset().catch((error: unknown) => console.log(`before reset: ${errorMessage(error)}`))

		if (existsSync(output)) {
			hooks?.findings?.attach(path.basename(output), tail(output, 3000))
		}

		try {
			target.reset()
		} catch (error) {
			console.log(`cleanup: ${errorMessage(error)}`)
		}

		await feed?.close()
		xvfb?.kill()
	}
}
