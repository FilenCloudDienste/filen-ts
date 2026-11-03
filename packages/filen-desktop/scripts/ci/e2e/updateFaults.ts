import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { TEST_UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS, UPDATE_STALL_MS } from "../../../src/main/updater.ts"
import { hashStream, parseFeed, rewriteFeed } from "../../feed.ts"
import {
	errorMessage,
	fail,
	powershellBounded,
	psQuote,
	runBounded,
	section,
	waitFor,
	type FeedFault,
	type FeedFaultPlan
} from "../support.ts"
import type { Platform, Target } from "../targets.ts"
import { createFindings, type Findings } from "./findings.ts"
import { feedFor, processesAt, START_TIMEOUT_MS, TEST_FEED_ENV, TEST_FEED_LOG } from "./update.ts"

// The update fault launch (plan D5, proving the updater fixes F1-F4): before the real update, N-1 runs once against
// its own feed server, which fails each of its checks in another way, keyed on the manifest request's ordinal. N-1 is
// built from the same commit, so it checks every TEST_UPDATE_CHECK_INTERVAL_MS under a test feed.
//
//   1  manifest 500
//   2  the update file 404
//   3  the update file's socket cut at 40% (the full Content-Length announced)
//   4  one byte of the update file flipped
//   5  macOS: a truncated zip with its own sha512 in latest-mac.yml: electron-updater accepts it and Squirrel refuses it,
//      which must clear the ready state (F2) so that another check follows
//   6  the update file stalled at 30% on a live socket: the no-progress watchdog must cancel it (F1), and another check
//      must follow; the server destroys a stalled file's socket once released, never sending the rest
//   7  stalled at 30% again, and N-1 ended meanwhile: a hard kill at install depth, a graceful quit in a deep chain
//
// After each step: the same N-1 process runs, exactly one "updater: check failed" line was logged, nothing was
// reported ready to install (step 5 aside), no installer (or ShipIt) runs, and pending/ holds no update-info.json and
// no full-size download; neither does pending/ once the launch ended, after which it is emptied, so the real update
// downloads afresh. Every check after the first is held at the server (its manifest stalls before the first byte)
// until the step before it is asserted, so each step's lines are its own.

const CHECK_FAILED_LOG = "updater: check failed"
const READY_LOG = " is ready to install"
const SQUIRREL_LOG = "updater: Squirrel: "
const STALL_LOG = "updater: no progress for "
// How long the app's batched log writes may take to show a step's lines.
const LOG_SETTLE_MS = 15_000
const EXIT_TIMEOUT_MS = 2 * 60 * 1000
const TOOL_TIMEOUT_MS = 60_000
// The truncated zip of step 5: the head of the real one, enough to be a zip that Squirrel cannot unpack.
const TRUNCATED_BYTES = 1024 * 1024
// Where steps 6 and 7 stall the download.
const STALL_AT = 0.3

export interface FaultStep {
	name: string
	// What the step proves (its check's name).
	proves: string
	manifest: FeedFault | null
	file: FeedFault | null
	// Squirrel's refusal of a complete download instead of a failed check (step 5).
	squirrel: boolean
	// The step's stall must end through the no-progress watchdog (step 6).
	watchdog: boolean
	// From the step's start, how long until the next check must have come.
	nextWithinMs: number
}

// The steps for a platform; `truncated` (macOS) is step 5's manifest and zip.
export function faultSteps(platform: Platform, truncated: { manifest: Buffer; zip: Buffer } | null): FaultStep[] {
	const next = 3 * TEST_UPDATE_CHECK_INTERVAL_MS
	const step = (fields: Partial<FaultStep> & Pick<FaultStep, "name" | "proves">): FaultStep => ({
		manifest: null,
		file: null,
		squirrel: false,
		watchdog: false,
		nextWithinMs: next,
		...fields
	})

	return [
		step({
			name: "manifest 500",
			proves: "a failing manifest fails one check and nothing else",
			manifest: { status: 500 },
			nextWithinMs: UPDATE_FIRST_CHECK_DELAY_MS + next
		}),
		step({ name: "file 404", proves: "a missing update file fails one check, nothing staged", file: { status: 404 } }),
		step({
			name: "cut at 40%",
			proves: "a download cut short fails one check, nothing staged",
			file: { cutAt: 0.4 }
		}),
		step({
			name: "one byte flipped",
			proves: "a corrupt download fails its sha512 check, nothing staged or ready",
			file: { flipAt: 0.5 }
		}),
		...(platform === "mac" && truncated !== null
			? [
					step({
						name: "truncated zip",
						proves: "Squirrel's refusal clears the ready state and another check follows within 3 intervals (F2)",
						manifest: { body: truncated.manifest },
						file: { body: truncated.zip },
						squirrel: true
					})
				]
			: []),
		step({
			name: `stall at ${String(STALL_AT * 100)}%`,
			proves: "the no-progress watchdog ends a stalled download and another check follows (F1)",
			file: { stallAt: STALL_AT },
			watchdog: true,
			nextWithinMs: UPDATE_STALL_MS + next
		}),
		step({
			name: "ended during a stalled download",
			proves: "N-1 ended mid-download leaves nothing staged, ready or installing",
			file: { stallAt: STALL_AT }
		})
	]
}

// The server's plan for `steps`. The update file's fault is the one of the step whose manifest came last; every
// manifest after the first is held before its first byte (a gate the harness lifts with release()). Byte ranges (the
// AppImage's differential attempt) are refused, so only the full download carries a step's fault. Anything past the
// last step fails, so no update is ever installed from this feed.
export function faultPlan(steps: readonly FaultStep[], manifest: string, updateFile: string): FeedFaultPlan {
	let manifests = 0

	return ({ name, ordinal, range }) => {
		if (name === manifest) {
			manifests = ordinal

			const step = steps[ordinal - 1]

			if (step === undefined) {
				return { status: 500 }
			}

			return ordinal === 1 ? step.manifest : { ...step.manifest, stallAt: 0 }
		}

		if (name === updateFile) {
			return range ? { status: 416 } : (steps[manifests - 1]?.file ?? { status: 500 })
		}

		return null
	}
}

export interface LogMark {
	size: number
}

function mainLogOf(target: Pick<Target, "userData">, name = "main.log"): string {
	return path.join(target.userData, "logs", name)
}

function readOrEmpty(file: string): Buffer {
	return existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
}

// Where main.log ends now.
export function logMark(target: Pick<Target, "userData">): LogMark {
	const file = mainLogOf(target)

	return { size: existsSync(file) ? statSync(file).size : 0 }
}

// main.log past `mark`. Once the log rotated (main.log became main.1.log), what followed the mark went on there.
export function logSince(target: Pick<Target, "userData">, mark: LogMark): string {
	const current = readOrEmpty(mainLogOf(target))

	if (current.length < mark.size) {
		return Buffer.concat([readOrEmpty(mainLogOf(target, "main.1.log")).subarray(mark.size), current]).toString("utf8")
	}

	return current.subarray(mark.size).toString("utf8")
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1
}

// What electron-updater left in pending/ that only a finished, verified download may leave.
export function pendingProblems(target: Pick<Target, "updaterCache">, fullSize: number): string[] {
	const pending = path.join(target.updaterCache, "pending")

	if (!existsSync(pending)) {
		return []
	}

	return readdirSync(pending).flatMap(name => {
		if (name === "update-info.json") {
			return ["pending/update-info.json exists"]
		}

		try {
			const { size } = statSync(path.join(pending, name))

			return size >= fullSize ? [`pending/${name} is a full-size download (${String(size)} bytes)`] : []
		} catch {
			// Gone meanwhile.
			return []
		}
	})
}

// Processes installing an update: anything started from the updater's cache (the NSIS installer and elevate.exe, dpkg
// or mv on a downloaded file), and on macOS ShipIt. As "pid command line".
export async function installerProcesses(target: Target): Promise<string[]> {
	const cache = target.updaterCache

	if (target.platform === "win") {
		const result = await powershellBounded(
			`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'elevate.exe' -or ($_.CommandLine -and $_.CommandLine.IndexOf(${psQuote(cache)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
			TOOL_TIMEOUT_MS
		)

		if (result.timedOut || result.status !== 0) {
			fail(`listing processes failed: ${result.timedOut ? "timed out" : result.stderr}`)
		}

		return result.stdout.split(/\r?\n/).filter(line => line.trim() !== "")
	}

	if (target.platform === "mac") {
		const result = await runBounded("ps", ["-axo", "pid=,command="], TOOL_TIMEOUT_MS)

		if (result.timedOut || result.status !== 0) {
			fail(`ps failed: ${result.timedOut ? "timed out" : result.stderr}`)
		}

		return result.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(line => /\/ShipIt(\s|$)/.test(line) || line.includes(cache))
	}

	return readdirSync("/proc")
		.filter(entry => /^\d+$/.test(entry) && Number(entry) !== process.pid)
		.flatMap(pid => {
			try {
				const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()

				return cmdline.includes(cache) ? [`${pid} ${cmdline}`] : []
			} catch {
				return []
			}
		})
}

// Step 5's files: the head of the real zip, and the manifest with that head's sha512 and size for it.
async function truncatedUpdate(nextDir: string, manifest: string, updateFile: string): Promise<{ manifest: Buffer; zip: Buffer }> {
	const fd = openSync(path.join(nextDir, updateFile), "r")
	const zip = Buffer.alloc(TRUNCATED_BYTES)

	try {
		const read = readSync(fd, zip, 0, TRUNCATED_BYTES, 0)

		if (read !== TRUNCATED_BYTES) {
			fail(`${updateFile} is shorter than ${String(TRUNCATED_BYTES)} bytes`)
		}
	} finally {
		closeSync(fd)
	}

	const hash = await hashStream(Readable.from([zip]))
	const { text, changed } = rewriteFeed(readFileSync(path.join(nextDir, manifest), "utf8"), new Map([[updateFile, hash]]))

	if (!changed.includes(updateFile)) {
		fail(`${manifest} could not be rewritten for the truncated ${updateFile}`)
	}

	return { manifest: Buffer.from(text), zip }
}

export interface FaultLaunchOptions {
	target: Target
	nextDir: string
	nextVersion: string
	fromVersion: string
	work: string
	// A deep chain's findings; without, the launch keeps its own and the returned function settles them.
	findings?: Findings | undefined
	// Ends N-1 in the last step (a graceful quit); without, it is killed.
	stop?: ((pids: readonly number[]) => Promise<void>) | undefined
}

// Runs the fault launch with the installed N-1 (not running); returns once N-1 is gone. The returned function fails
// the run if any of the launch's own checks failed (a no-op with a chain's findings): called after the real update, so
// that a fault never hides the update's own result.
export async function runFaultLaunch(options: FaultLaunchOptions): Promise<() => void> {
	const { target, nextDir, nextVersion, fromVersion, work, stop } = options
	const own = options.findings === undefined
	const findings = options.findings ?? createFindings("update-faults", path.join(work, "update-faults"))

	section(`update faults: ${fromVersion} against a failing feed`)

	const entry =
		parseFeed(readFileSync(path.join(nextDir, target.manifest), "utf8"), target.manifest).files.find(
			file => file.url === target.updateFile
		) ?? fail(`${target.manifest} does not list ${target.updateFile}`)
	const truncated = target.platform === "mac" ? await truncatedUpdate(nextDir, target.manifest, target.updateFile) : null
	const steps = faultSteps(target.platform, truncated)
	const { server } = await feedFor(target, nextDir, nextVersion, faultPlan(steps, target.manifest, target.updateFile))
	const manifests = () => server.requests.filter(request => request.path === target.manifest)
	let pids: number[] = []

	try {
		let mark = logMark(target)

		target.launch({ ...process.env, [TEST_FEED_ENV]: server.url })
		await waitFor(`${fromVersion} to start and take the failing feed`, START_TIMEOUT_MS, () => {
			const text = logSince(target, mark)

			return text.includes(` INFO Filen ${fromVersion} starting (`) && text.includes(TEST_FEED_LOG) ? true : null
		})
		pids = (
			await waitFor(`${fromVersion}'s main process`, START_TIMEOUT_MS, () => {
				const found = processesAt(target)

				return found.length > 0 ? found : null
			})
		).map(found => found.pid)
		console.log(`fault launch: pid ${pids.join(", ")}`)

		for (const [index, step] of steps.entries()) {
			const ordinal = index + 1
			const name = `update fault ${String(ordinal)} (${step.name}): ${step.proves}`

			// This step's check was held at the gate while the step before it was asserted (none before the first).
			server.release()

			if (ordinal === steps.length) {
				await findings.check(name, async () => {
					const stallBytes = Math.floor(entry.size * STALL_AT)
					const gate = server.requests.indexOf(manifests()[ordinal - 1] ?? fail(`check ${String(ordinal)} never came`))

					await waitFor(`the download to stall at ${String(STALL_AT * 100)}%`, step.nextWithinMs, () =>
						server.requests.some(
							(request, at) => at > gate && request.path === target.updateFile && request.bytes >= stallBytes
						)
							? true
							: null
					)

					const how = stop === undefined ? "killed" : "quit"

					if (stop === undefined) {
						target.kill(pids)
					} else {
						await stop(pids)
					}

					await waitFor(`${fromVersion} to end (${how})`, EXIT_TIMEOUT_MS, () =>
						processesAt(target).some(found => pids.includes(found.pid)) ? null : true
					)

					const segment = logSince(target, mark)
					const problems = [
						...(segment.includes(READY_LOG) ? ["an update was reported ready to install"] : []),
						...(await installerProcesses(target)).map(line => `an installer runs: ${line}`),
						...pendingProblems(target, entry.size)
					]

					if (problems.length > 0) {
						fail(problems.join("; "))
					}

					return `${fromVersion} ${how} with the download stalled at ${String(stallBytes)} of ${String(entry.size)} bytes; nothing staged, ready or installing`
				})

				break
			}

			// Whether the next step can run: its check came and N-1 still runs.
			let goOn = false

			await findings.check(name, async () => {
				await waitFor(`check ${String(ordinal + 1)} after "${step.name}"`, step.nextWithinMs, () =>
					manifests().length > ordinal ? true : null
				)

				const evidence = (text: string) =>
					count(text, CHECK_FAILED_LOG) > 0 || (step.squirrel && text.includes(SQUIRREL_LOG)) ? text : null
				const segment = await waitFor(
					`the lines of "${step.name}" in main.log`,
					LOG_SETTLE_MS,
					() => evidence(logSince(target, mark)),
					250
				).catch(() => logSince(target, mark))
				const failures = count(segment, CHECK_FAILED_LOG)
				const running = new Set(processesAt(target).map(found => found.pid))

				goOn = pids.every(pid => running.has(pid))

				const problems = [
					...(goOn ? [] : [`${fromVersion}'s process ${pids.join(", ")} is gone`]),
					...(step.squirrel
						? [
								...(segment.includes(SQUIRREL_LOG) || failures === 1
									? []
									: ["neither Squirrel's refusal nor a failed check was logged"]),
								...(failures > 1 ? [`${String(failures)} "check failed" lines`] : [])
							]
						: failures === 1
							? []
							: [`${String(failures)} "check failed" lines, expected exactly one`]),
					...(!step.squirrel && segment.includes(READY_LOG) ? ["an update was reported ready to install"] : []),
					...(step.watchdog && !segment.includes(STALL_LOG) ? ["the no-progress watchdog logged nothing"] : []),
					...(await installerProcesses(target)).map(line => `an installer runs: ${line}`),
					...(step.squirrel ? [] : pendingProblems(target, entry.size))
				]

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `${String(failures)} failed check(s)${step.squirrel ? `, Squirrel ${segment.includes(SQUIRREL_LOG) ? "refused" : "said nothing"}, ready ${segment.includes(READY_LOG) ? "logged" : "not logged"}` : ""}; check ${String(ordinal + 1)} came; ${fromVersion} still running`
			})
			mark = logMark(target)

			if (!goOn) {
				break
			}
		}
	} catch (error) {
		await findings.check("the update fault launch ran", () => fail(errorMessage(error)))
	} finally {
		server.release()

		// Whatever runs from the install now is the fault launch's (the real launch needs the single-instance lock).
		let left = processesAt(target).map(found => found.pid)
		const ended = (pids: readonly number[]) => (processesAt(target).some(found => pids.includes(found.pid)) ? null : true)

		// A deep chain's N-1 runs signed in with its drive and serve up: quit it gracefully first, so it unmounts and
		// stops them itself. A main pid killed outright orphans rclone with the mount point still busy.
		if (left.length > 0 && stop !== undefined) {
			const quitting = left

			await stop(quitting)
				.then(() => waitFor(`${fromVersion} to end (quit)`, EXIT_TIMEOUT_MS, () => ended(quitting)))
				.catch((error: unknown) => console.log(`fault launch cleanup: ${errorMessage(error)}`))
			left = processesAt(target).map(found => found.pid)
		}

		if (left.length > 0) {
			const killing = left

			target.kill(killing)
			await waitFor(`${fromVersion} to end (killed)`, EXIT_TIMEOUT_MS, () => ended(killing)).catch((error: unknown) =>
				console.log(`fault launch cleanup: ${errorMessage(error)}`)
			)
		}

		await server.close()
	}

	await findings.check("the update fault launch left no update in pending/ for the real one", () => {
		const problems = pendingProblems(target, entry.size)

		// Whatever is there, the real update must not reuse it.
		rmSync(path.join(target.updaterCache, "pending"), { recursive: true, force: true })

		if (problems.length > 0) {
			fail(problems.join("; "))
		}

		return "no update-info.json and no full-size download; pending/ emptied"
	})

	return own ? () => findings.finish() : () => undefined
}
