import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type {
	DesktopMountsOverview,
	DesktopMountsResult,
	DesktopSyncActivity,
	DesktopSyncOverview,
	DesktopSyncPlan,
	DesktopSyncResult
} from "@filen/shared/desktop"
import type { StringifiedClient } from "@filen/sdk-rs"
import type { Page } from "playwright-core"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { PROFILE_ENTRIES } from "../../../../src/main/signOut.ts"
import type { Target } from "../../targets.ts"
import { APP_ORIGIN, desktop, desktopCall, signOut } from "../app.ts"
import { listTargets } from "../cdp/inspector.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { openCloud, runDir, type Cloud } from "../cloud.ts"
import { LOCK_SERVER_TTL_MS } from "../driveLock.ts"
import { createFindings, type Findings } from "../findings.ts"
import { exitWithin, launchDebuggable, type LaunchExtra, type Launched } from "../launch.ts"
import { type DesktopOs, osFor } from "../os.ts"
import { redactor } from "../redact.ts"
import { type SignIn, signInMode } from "../seed.ts"
import { type Credentials, harnessSession, type HarnessRemote, mask, secretsOf, takeCredentials } from "../session.ts"
import { filesHolding, localSnapshot, type Snapshot } from "../snapshot.ts"
import { runUpdate, START_TIMEOUT_MS, tail, type UpdateHooks, type UpdateOptions } from "../update.ts"

// What the deep chains share: the account (credentials, the handed session, the redacted findings), the run's local and
// cloud directories, launching and quitting 4.x with its debugging port, reading the window.desktop contract, and the
// run around the update scenario (evidence before the reset, the cloud directory purged, the findings finished).

export const SETUP_TIMEOUT_MS = 2 * 60 * 1000
export const QUIET_MS = 30_000
export const QUIET_MAX_MS = 3 * 60 * 1000
export const LIVE_TIMEOUT_MS = 2 * 60 * 1000
// A live edit's upload, which waits for the account's drive-write first: the live window, plus one ordinary batch of
// another client (sdk-rs PASS_LOCK_MAX_HOLD, 60 s) and a lease another entry's lost network left for the server's TTL.
export const LIVE_UPLOAD_MS = LIVE_TIMEOUT_MS + 60_000 + LOCK_SERVER_TTL_MS
export const EXIT_TIMEOUT_MS = 60_000
const STAGGER_MAX_S = 300
// What a sign-out deletes and logs (src/main/signOut.ts), the drive idle and the native host running.
const SIGN_OUT_FILES = ["lock.vault", "migration.stash"]
const PROFILE_SENTINEL_KEY = "filen-e2e-profile-sentinel"

// What the chain knows before its sign-out: the launch's first main.log line, and a value the page stored then.
export interface SignOutWitness {
	startLine: string
	sentinel: string
}

// An entry's identity, to tell it from one created anew.
function identity(file: string): { ino: number; birthtimeMs: number } | null {
	const stat = statSync(file, { throwIfNoEntry: false })

	return stat === undefined ? null : { ino: stat.ino, birthtimeMs: stat.birthtimeMs }
}
// How long a launch may show no page before it counts as started hidden (startMinimized) and a second instance shows it.
const HIDDEN_PROBE_MS = 30_000

// Activity that means the engine moved, created or removed something.
export const TRANSFER_KINDS = new Set<DesktopSyncActivity["kind"]>([
	"uploaded",
	"downloaded",
	"createdRemoteDirectory",
	"createdLocalDirectory",
	"trashedRemote",
	"deletedLocal",
	"movedRemote",
	"movedLocal",
	"binned",
	"failed",
	"conflict",
	"deletionsHeld",
	"passFailed"
])

// The engine's bin in a pair root: not the user's tree.
export const BIN_DIR = ".filen-sync-trash"

export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch {
		return null
	}
}

export function json(value: unknown): string {
	return JSON.stringify(value)
}

// The engine's remote cache (sdk-rs cache/state: every drive event of the account, whichever client caused it, is
// stored, applied and its watermark advanced there), so it is written whenever anything changes anywhere on the
// account, other jobs of the same run included. What the engine keeps of its pairs is the baseline.
const ACCOUNT_CACHE = /[\\/]sync-engine[\\/][^\\/]+[\\/]cache\.db(-wal|-shm|-journal)?$/

// Size and mtime per file below `dirs` (the account cache aside): changes whenever anything is written.
function fingerprint(dirs: readonly string[]): Map<string, string> {
	const files = new Map<string, string>()
	const walk = (dir: string) => {
		for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name)

			if (entry.isDirectory()) {
				walk(full)
			} else if (!ACCOUNT_CACHE.test(full)) {
				const stat = statSync(full, { throwIfNoEntry: false })

				files.set(full, `${String(stat?.size)} ${String(stat?.mtimeMs)}`)
			}
		}
	}

	for (const dir of dirs) {
		walk(dir)
	}

	return files
}

// The files added, removed or rewritten between two fingerprints.
function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file))
}

// The newest modification time of any file below `dir` (0 when there is none).
export function newestWrite(dir: string): number {
	let newest = 0

	for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true, recursive: true }) : []) {
		if (entry.isFile()) {
			newest = Math.max(newest, statSync(path.join(entry.parentPath, entry.name), { throwIfNoEntry: false })?.mtimeMs ?? 0)
		}
	}

	return newest
}

// Until nothing under `dirs` changed for QUIET_MS, at most QUIET_MAX_MS; a failure names what kept changing.
export async function quiet(dirs: readonly string[]): Promise<void> {
	const deadline = Date.now() + QUIET_MAX_MS
	const writes = new Map<string, number>()
	let last = fingerprint(dirs)
	let since = Date.now()

	while (Date.now() - since < QUIET_MS) {
		if (Date.now() > deadline) {
			const named = [...writes].sort((a, b) => b[1] - a[1]).map(([file, polls]) => `${file} (${String(polls)})`)

			fail(
				`still writing after ${String(QUIET_MAX_MS / 1000)} s; changed in how many 5 s polls: ${named.slice(0, 20).join(", ")}${named.length > 20 ? ` and ${String(named.length - 20)} more` : ""}`
			)
		}

		await sleep(5000)

		const now = fingerprint(dirs)
		const changed = changedFiles(last, now)

		if (changed.length > 0) {
			for (const file of changed) {
				writes.set(file, (writes.get(file) ?? 0) + 1)
			}

			last = now
			since = Date.now()
		}
	}
}

// A contract result's value; anything but { ok: true, value } fails, named, with what came back.
export function ok<T>(what: string, result: DesktopSyncResult<T> | DesktopMountsResult<T>): T {
	const shaped: unknown = result

	if (typeof shaped !== "object" || shaped === null || !("ok" in shaped) || typeof shaped.ok !== "boolean") {
		fail(`${what}: not a result: ${json(shaped)}`)
	}

	if (!result.ok) {
		fail(`${what}: ${json(result.error)}`)
	}

	if (!("value" in result)) {
		fail(`${what}: ok without a value`)
	}

	return result.value
}

// Every path below `root` with its size, sorted; for the owner's review of what stays behind.
export function inventory(root: string): string {
	const lines: string[] = []
	const walk = (dir: string) => {
		for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name)

			if (entry.isDirectory()) {
				lines.push(`${path.relative(root, full)}/`)
				walk(full)
			} else {
				lines.push(`${path.relative(root, full)} ${String(statSync(full, { throwIfNoEntry: false })?.size ?? 0)}`)
			}
		}
	}

	walk(root)

	return lines.sort().join("\n") || "(empty)"
}

export interface Chain {
	readonly name: string
	readonly target: Target
	readonly work: string
	readonly artifacts: string
	readonly credentials: Credentials
	readonly remote: HarnessRemote
	// The run's handed session, which seeds the app when this chain does not sign in through its form.
	readonly client: StringifiedClient
	// Through the form, or seeded (the plan's choice for this entry and chain).
	readonly signIn: SignIn
	readonly findings: Findings
	readonly cloud: Cloud
	readonly os: DesktopOs
	// This chain's directories: in the cloud (relative to the drive root) and on disk.
	readonly cloudDir: string
	readonly localDir: string
	// Chromium's logging and the app's stdout and stderr of every launch.
	readonly appOutput: string
	launched: Launched | null
	// A command 4.x is started through on the next connect() (the offline spike's group), null for none.
	launchVia: readonly string[] | null
	renderer: Renderer | null
	signedIn: boolean
	// A value never to appear in a log or artifact from here on.
	secret(value: string): void
	userData(...parts: string[]): string
	page(): Page
	syncOverview(): Promise<DesktopSyncOverview>
	mountsOverview(): Promise<DesktopMountsOverview>
	// Launches 4.x with its debugging port and connects to its page; a launch that shows no page (startMinimized) gets a
	// second instance, which shows the window. Returns whether it started hidden. `extra` reaches this launch only.
	connect(extra?: LaunchExtra): Promise<boolean>
	// Asks 4.x's main processes to quit gracefully (DesktopOs.requestQuit), failing on an unclean exit or a crash report.
	quit(what: string): Promise<void>
	// A step that leaves a session behind on failure signs out through the page first.
	signedOutOnFailure(step: () => Promise<void>): Promise<void>
	// Before the sign-out, signed in: main.log as it is (the sign-out deletes it) and the witness.
	beforeSignOut(): Promise<SignOutWitness>
	// After a sign-out with the drive idle and the host running (src/main/signOut.ts): the user's sync and drive data,
	// the stash, the PIN record and the logs gone, and the marker left for the browser profile.
	signOutWiped(witness: SignOutWitness): Promise<string>
	// With the app quit after its sign-out: one launch, which deletes the browser profile before ready, to its sign-in
	// screen, the marker gone and the page without the value stored before the sign-out. The profile's files are left
	// alone while it runs (Windows refuses to open what Chromium holds).
	profileWipedOnLaunch(): Promise<string>
	// Once that launch quit: none of the profile's entries is the one from before it, and no profile file holds the
	// witness's value or `oldValues`.
	profileHoldsNoOldValue(witness: SignOutWitness, oldValues?: readonly string[]): string
	// Deep jobs that sign in through a form do so some seconds apart (the plan's per-entry offset); logins are
	// rate-limited.
	stagger(): Promise<void>
	// The local snapshot of a pair root, the engine's bin left out.
	snapshotOf(name: string): Promise<Snapshot>
	rootOf(name: string): string
	// No transfer in any pair's activity but the `allowed` ("<pair>:<kind>:<relPath>"), and every plan empty but for
	// exactly the held `conflicts` per pair name. With `since` (epoch ms), only the activity from then on counts.
	quietActivity(
		pairs: readonly { name: string; id: string }[],
		allowed: ReadonlySet<string>,
		conflicts?: Readonly<Record<string, number>>,
		since?: number
	): Promise<string>
	// The update scenario with the chain's hooks, then evidence, cleanup and the findings.
	run(options: Omit<UpdateOptions, "hooks">, hooks: Omit<UpdateHooks, "beforeReset">): Promise<void>
}

export async function openChain(name: string, options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<Chain> {
	const { target, work } = options

	const os = osFor(target)

	const credentials = takeCredentials()
	const { client, remote } = harnessSession()
	const secrets = [credentials.email, credentials.password, ...secretsOf(remote)]
	const findings = createFindings(name, artifacts, text => redactor(secrets)(text))
	const cloud = await openCloud(remote, work)

	await os.prepare()

	const entry = `${target.platform}-${options.arch}-${target.format}`
	const localDir = path.join(homedir(), "FilenE2E", path.posix.basename(runDir()), name)
	const userData = (...parts: string[]) => path.join(target.userData, ...parts)
	const appOutput = path.join(work, `${name}-app-output.log`)

	// The profile's entries as they were before the launch after a sign-out, and when it started.
	let profileBefore: { at: number; entries: Map<string, ReturnType<typeof identity>> } | undefined

	const chain: Chain = {
		name,
		target,
		work,
		artifacts,
		credentials,
		remote,
		client,
		signIn: signInMode(),
		findings,
		cloud,
		os,
		cloudDir: `${runDir()}/${entry}/${name}`,
		localDir,
		appOutput,
		launched: null,
		launchVia: null,
		renderer: null,
		signedIn: false,
		secret(value) {
			secrets.push(value)
			mask([value])
		},
		userData,
		page: () => chain.renderer?.page ?? fail("no page connected"),
		syncOverview: () => desktop<DesktopSyncOverview>(chain.page(), "window.desktop.sync.overview()"),
		mountsOverview: () => desktop<DesktopMountsOverview>(chain.page(), "window.desktop.mounts.overview()"),
		rootOf: pair => path.join(localDir, pair),
		snapshotOf: pair => localSnapshot(path.join(localDir, pair), { skip: relPath => relPath === BIN_DIR }),

		async connect(extra) {
			mkdirSync(work, { recursive: true })

			const launched = await launchDebuggable(target, false, appOutput, chain.launchVia ?? undefined, extra)

			chain.launched = launched

			const shown = await waitFor(
				"a page or a hidden start",
				HIDDEN_PROBE_MS,
				async () => ((await listTargets(launched.debugPort))?.some(item => item.url.startsWith(APP_ORIGIN)) === true ? true : null),
				1000
			).catch(() => false)

			if (!shown) {
				const exit = await exitWithin(launched, 0)

				if (exit !== null) {
					fail(`the launch exited before its debugging port answered, handed to an instance still running: ${json(exit)}`)
				}

				// The single-instance lock hands the second launch to the first, which shows its window. An AppImage's second
				// runtime would extract to the running one's $TMPDIR/appimage_extracted_<digest> (same file, same digest) and
				// delete it once its app hands over and exits, taking the running app's files (rclone among them) with it: it
				// gets a TMPDIR of its own. The lock is found through userData, never TMPDIR.
				target.launch(
					target.format === "AppImage"
						? { ...process.env, TMPDIR: mkdtempSync(path.join(work, "second-instance-")) }
						: { ...process.env }
				)
			}

			chain.renderer = await connectRenderer(launched.debugPort, APP_ORIGIN, START_TIMEOUT_MS)

			return !shown
		},

		async quit(what) {
			await chain.renderer?.browser.close().catch(() => undefined)
			chain.renderer = null

			const pids = target.mainProcesses().map(item => item.pid)

			if (pids.length === 0 && chain.launched !== null && (await exitWithin(chain.launched, 0)) === null) {
				fail(`${what}: the launched instance is running but no main process is visible`)
			}

			await os.requestQuit(pids)

			const evidence = async (): Promise<string[]> => {
				const cores: string[] = []

				for (const pid of pids) {
					const report = await os.crashReport(target.executable, pid)

					if (report !== null) {
						cores.push(report.slice(0, report.indexOf("\n")))
						findings.attach(`${name}-${what}-core-${String(pid)}.txt`, report)
					}
				}

				findings.attach(`${name}-${what}-output.log`, tail(appOutput, 3000))

				return cores
			}

			if (chain.launched !== null && pids.includes(chain.launched.child.pid ?? -1)) {
				const exit = await exitWithin(chain.launched, EXIT_TIMEOUT_MS)

				if (exit === null || exit.code !== 0 || exit.signal !== null) {
					const cores = await evidence()

					fail(`${what} did not quit gracefully: ${json(exit)}${cores.length > 0 ? ` (${cores.join(", ")})` : ""}`)
				}
			}

			await waitFor(`${what} to exit`, EXIT_TIMEOUT_MS, () => (target.mainProcesses().length === 0 ? true : null), 1000)
			chain.launched = null

			const cores = await evidence()

			if (cores.length > 0) {
				fail(`${what} crashed while quitting: ${cores.join(", ")}`)
			}
		},

		async signedOutOnFailure(step) {
			try {
				await step()
			} catch (error) {
				if (chain.signedIn && chain.renderer !== null) {
					// The sign-out deletes the logs: the app's side of the failure is kept first.
					findings.attach(`${name}-main-before-failure-sign-out.log`, tail(userData("logs", "main.log"), 100_000))
					await findings.check("sign out after the failure", () =>
						signOut(chain.page(), findings, credentials.email, artifacts, name)
					)
				}

				throw error
			}
		},

		async beforeSignOut() {
			const log = tail(userData("logs", "main.log"), 100_000)

			findings.attach(`${name}-main-before-sign-out.log`, log)

			const startLine =
				log
					.split("\n")
					.findLast(line => / starting \(Electron /.test(line))
					?.trim() ?? fail("main.log has no starting line before the sign-out")
			const sentinel = randomBytes(16).toString("hex")

			await chain.page().evaluate(([key, value]) => localStorage.setItem(key, value), [PROFILE_SENTINEL_KEY, sentinel] as const)

			return { startLine, sentinel }
		},

		async signOutWiped(witness) {
			const userDirs = (root: string) =>
				existsSync(userData(root))
					? readdirSync(userData(root), { withFileTypes: true })
							.filter(entry => entry.isDirectory())
							.map(entry => `${root}/${entry.name}`)
					: []
			// The logs directory goes last; the file log may start a new main.log after it, never with this launch's start.
			const oldLog = () => existsSync(userData("logs")) && tail(userData("logs", "main.log"), 100_000).includes(witness.startLine)
			const left = () => [
				...userDirs("sync-engine"),
				...userDirs("mounts"),
				...SIGN_OUT_FILES.filter(file => existsSync(userData(file))),
				...(oldLog() ? ["logs (this launch's main.log)"] : [])
			]

			await waitFor("the sign-out to delete the user's data", SETUP_TIMEOUT_MS, () => (left().length === 0 ? true : null)).catch(
				(error: unknown) => fail(`${errorMessage(error)}; left: ${left().join(", ")}`)
			)

			const marker = readJson(userData("signOut.pending"))

			if (typeof marker !== "object" || marker === null || !("profile" in marker) || marker.profile !== true) {
				fail(`signOut.pending does not list the browser profile: ${json(marker)}`)
			}

			return "sync-engine and mounts hold no user directory; lock.vault, migration.stash and the logs gone; signOut.pending lists the profile"
		},

		async profileWipedOnLaunch() {
			profileBefore = { at: Date.now(), entries: new Map(PROFILE_ENTRIES.map(entry => [entry, identity(userData(entry))])) }

			await chain.connect()
			await chain.page().getByText("Sign in to Filen").waitFor({ state: "visible", timeout: START_TIMEOUT_MS })
			await waitFor("signOut.pending to be removed", SETUP_TIMEOUT_MS, () => (existsSync(userData("signOut.pending")) ? null : true))

			if (!tail(userData("logs", "main.log"), 4000).includes("sign-out: browser profile deleted")) {
				fail("main.log does not log the browser profile's deletion")
			}

			if ((await chain.page().evaluate(key => localStorage.getItem(key), PROFILE_SENTINEL_KEY)) !== null) {
				fail("the page's localStorage still has the value stored before the sign-out")
			}

			return "signOut.pending gone; main.log logs the deletion; localStorage without the old value"
		},

		profileHoldsNoOldValue(witness, oldValues = []) {
			const before = profileBefore ?? fail("the profile was not recorded before the launch")
			const kept = [...before.entries].filter(([entry, old]) => {
				const now = identity(userData(entry))

				return old !== null && now !== null && now.ino === old.ino && now.birthtimeMs <= before.at
			})

			if (kept.length > 0) {
				fail(`not deleted: ${kept.map(([entry]) => entry).join(", ")}`)
			}

			const held = PROFILE_ENTRIES.flatMap(entry =>
				filesHolding(userData(entry), [witness.sentinel, ...oldValues]).map(file => path.join(entry, file))
			)

			if (held.length > 0) {
				fail(`old values left in ${held.join(", ")}`)
			}

			const existed = [...before.entries].filter(([, old]) => old !== null).length

			return `${String(existed)} profile entries deleted (recreated ones are new); no profile file holds a value from before the sign-out`
		},

		async stagger() {
			const seconds = Math.min(Number(process.env["E2E_STAGGER_SECONDS"] ?? "0") || 0, STAGGER_MAX_S)

			if (seconds > 0) {
				console.log(`waiting ${String(seconds)} s before the sign-in (stagger)`)
				await sleep(seconds * 1000)
			}
		},

		async quietActivity(pairs, allowed, conflicts = {}, since = 0) {
			const problems: string[] = []

			for (const pair of pairs) {
				const activity = await desktop<DesktopSyncActivity[]>(chain.page(), `window.desktop.sync.activity(${json(pair.id)}, 200)`)

				problems.push(
					...activity
						.filter(
							item =>
								item.at >= since &&
								TRANSFER_KINDS.has(item.kind) &&
								!allowed.has(`${pair.name}:${item.kind}:${item.relPath ?? ""}`)
						)
						.map(item => `${pair.name}: ${item.kind} ${item.relPath ?? ""}`)
				)

				const plan = ok(
					"plan",
					await desktop<DesktopSyncResult<DesktopSyncPlan | null>>(chain.page(), `window.desktop.sync.plan(${json(pair.id)})`)
				)

				if (plan !== null) {
					await desktopCall(chain.page(), `window.desktop.sync.releasePlan(${json(plan.planId)})`)

					const { actions, heldDeletions, refused } = plan.summary

					if (
						actions !== 0 ||
						heldDeletions !== 0 ||
						plan.summary.conflicts !== (conflicts[pair.name] ?? 0) ||
						refused !== null
					) {
						problems.push(`${pair.name}: plan ${json(plan.summary)}`)
					}
				}
			}

			if (problems.length > 0) {
				fail(problems.join("; "))
			}

			return "no unexpected transfer activity; every plan empty"
		},

		async run(updateOptions, hooks) {
			const beforeReset = async (): Promise<void> => {
				findings.attach(`${name}-main.log`, tail(userData("logs", "main.log"), 1000))
				findings.attach(`${name}-output.log`, tail(appOutput, 3000))
				await os.screenDump(path.join(artifacts, `${name}-last-screen.png`))
				await chain.renderer?.browser.close().catch(() => undefined)
			}

			// A quarantined app would meet Gatekeeper's first-launch prompt, which no user of an installed app sees.
			const unquarantined = async (when: string): Promise<void> => {
				const quarantine = os.quarantine

				if (quarantine !== undefined) {
					await findings.check(`the app carries no quarantine (${when})`, async () => {
						const attribute = await quarantine(target)

						if (attribute !== null) {
							fail(`quarantined: ${attribute}`)
						}

						return "no com.apple.quarantine attribute"
					})
				}
			}

			// The chain's whole budget (E2E_CHAIN_BUDGET_MINUTES, below the workflow step's timeout): once it is spent, the
			// evidence so far is written and the run fails by name, instead of the step being cut off with nothing kept.
			const budgetMinutes = Number(process.env["E2E_CHAIN_BUDGET_MINUTES"] ?? "") || 0
			const watchdog =
				budgetMinutes > 0
					? setTimeout(() => {
							void (async () => {
								console.error(`::error::${name}: the chain's ${String(budgetMinutes)}-minute budget ran out`)
								await beforeReset().catch(() => undefined)
								await findings.check(`the chain finished within its ${String(budgetMinutes)}-minute budget`, () =>
									fail("it did not")
								)
								await cloud.purge(chain.cloudDir).catch(() => undefined)

								try {
									findings.finish()
								} finally {
									process.exit(1)
								}
							})()
						}, budgetMinutes * 60_000)
					: undefined

			try {
				await runUpdate({
					...updateOptions,
					hooks: {
						...hooks,
						beforeReset,
						// The update fault launch's checks and its graceful quit (e2e/updateFaults.ts).
						findings,
						stopFaultLaunch: pids => os.requestQuit(pids),
						beforeUpdate: async () => {
							await unquarantined("installed, before its first launch")
							await hooks.beforeUpdate()
						},
						afterUpdate: async () => {
							await unquarantined("after the update")
							await hooks.afterUpdate()
						}
					}
				})
			} catch (error) {
				await findings.check("the chain ran to the end", () => fail(errorMessage(error)))
			} finally {
				clearTimeout(watchdog)
				await cloud.purge(chain.cloudDir).catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))
			}

			findings.finish()
		}
	}

	return chain
}
