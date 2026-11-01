import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
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
import type { Page } from "playwright-core"
import { errorMessage, fail, waitFor } from "../../support.ts"
import type { Target } from "../../targets.ts"
import { APP_ORIGIN, desktop, desktopCall, signOut } from "../app.ts"
import { listTargets } from "../cdp/inspector.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { openCloud, runDir, type Cloud } from "../cloud.ts"
import { createFindings, type Findings } from "../findings.ts"
import { exitWithin, launchDebuggable, type Launched } from "../launch.ts"
import { type DesktopOs, osFor } from "../os.ts"
import { redactor } from "../redact.ts"
import { type Credentials, harnessRemote, type HarnessRemote, mask, secretsOf, takeCredentials } from "../session.ts"
import { localSnapshot, type Snapshot } from "../snapshot.ts"
import { runUpdate, START_TIMEOUT_MS, tail, type UpdateHooks, type UpdateOptions } from "../update.ts"

// What the deep chains share: the account (credentials, the handed session, the redacted findings), the run's local and
// cloud directories, launching and quitting 4.x with its debugging port, reading the window.desktop contract, and the
// run around the update scenario (evidence before the reset, the cloud directory purged, the findings finished).

export const SETUP_TIMEOUT_MS = 2 * 60 * 1000
export const QUIET_MS = 30_000
export const QUIET_MAX_MS = 3 * 60 * 1000
export const LIVE_TIMEOUT_MS = 2 * 60 * 1000
export const EXIT_TIMEOUT_MS = 60_000
const STAGGER_MAX_S = 300
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

// Paths, sizes and mtimes below `dirs`: changes whenever anything is written.
function fingerprint(dirs: readonly string[]): string {
	const lines: string[] = []
	const walk = (dir: string) => {
		for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name)

			if (entry.isDirectory()) {
				walk(full)
			} else {
				const stat = statSync(full, { throwIfNoEntry: false })

				lines.push(`${full} ${String(stat?.size)} ${String(stat?.mtimeMs)}`)
			}
		}
	}

	for (const dir of dirs) {
		walk(dir)
	}

	return lines.join("\n")
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

// Until nothing under `dirs` changed for QUIET_MS, at most QUIET_MAX_MS.
export async function quiet(dirs: readonly string[]): Promise<void> {
	const deadline = Date.now() + QUIET_MAX_MS
	let last = fingerprint(dirs)
	let since = Date.now()

	while (Date.now() - since < QUIET_MS) {
		if (Date.now() > deadline) {
			fail(`still writing after ${String(QUIET_MAX_MS / 1000)} s`)
		}

		await sleep(5000)

		const now = fingerprint(dirs)

		if (now !== last) {
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
	readonly findings: Findings
	readonly cloud: Cloud
	readonly os: DesktopOs
	// This chain's directories: in the cloud (relative to the drive root) and on disk.
	readonly cloudDir: string
	readonly localDir: string
	// Chromium's logging and the app's stdout and stderr of every launch.
	readonly appOutput: string
	launched: Launched | null
	renderer: Renderer | null
	signedIn: boolean
	// A value never to appear in a log or artifact from here on.
	secret(value: string): void
	userData(...parts: string[]): string
	page(): Page
	syncOverview(): Promise<DesktopSyncOverview>
	mountsOverview(): Promise<DesktopMountsOverview>
	// Launches 4.x with its debugging port and connects to its page; a launch that shows no page (startMinimized) gets a
	// second instance, which shows the window. Returns whether it started hidden.
	connect(): Promise<boolean>
	// Asks 4.x's main processes to quit gracefully (DesktopOs.requestQuit), failing on an unclean exit or a crash report.
	quit(what: string): Promise<void>
	// A step that leaves a session behind on failure signs out through the page first.
	signedOutOnFailure(step: () => Promise<void>): Promise<void>
	// Deep jobs sign in some seconds apart (the plan's per-entry offset); logins are rate-limited per account.
	stagger(): Promise<void>
	// The local snapshot of a pair root, the engine's bin left out.
	snapshotOf(name: string): Promise<Snapshot>
	rootOf(name: string): string
	// No transfer in any pair's activity but the `allowed` ("<pair>:<kind>:<relPath>"), and every plan empty but for
	// exactly the held `conflicts` per pair name.
	quietActivity(
		pairs: readonly { name: string; id: string }[],
		allowed: ReadonlySet<string>,
		conflicts?: Readonly<Record<string, number>>
	): Promise<string>
	// The update scenario with the chain's hooks, then evidence, cleanup and the findings.
	run(options: Omit<UpdateOptions, "hooks">, hooks: Omit<UpdateHooks, "beforeReset">): Promise<void>
}

export async function openChain(name: string, options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<Chain> {
	const { target, work } = options

	const os = osFor(target)

	const credentials = takeCredentials()
	const remote = harnessRemote(credentials)
	const secrets = [credentials.email, credentials.password, ...secretsOf(remote)]
	const findings = createFindings(name, artifacts, text => redactor(secrets)(text))
	const cloud = await openCloud(remote, work)

	await os.prepare()

	const entry = `${target.platform}-${options.arch}-${target.format}`
	const localDir = path.join(homedir(), "FilenE2E", path.posix.basename(runDir()), name)
	const userData = (...parts: string[]) => path.join(target.userData, ...parts)
	const appOutput = path.join(work, `${name}-app-output.log`)

	const chain: Chain = {
		name,
		target,
		work,
		artifacts,
		credentials,
		remote,
		findings,
		cloud,
		os,
		cloudDir: `${runDir()}/${entry}/${name}`,
		localDir,
		appOutput,
		launched: null,
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

		async connect() {
			mkdirSync(work, { recursive: true })

			const launched = await launchDebuggable(target, false, appOutput)

			chain.launched = launched

			const shown = await waitFor(
				"a page or a hidden start",
				HIDDEN_PROBE_MS,
				async () => ((await listTargets(launched.debugPort))?.some(item => item.url.startsWith(APP_ORIGIN)) === true ? true : null),
				1000
			).catch(() => false)

			if (!shown) {
				// The single-instance lock hands the second launch to the first, which shows its window.
				target.launch({ ...process.env })
			}

			chain.renderer = await connectRenderer(launched.debugPort, APP_ORIGIN, START_TIMEOUT_MS)

			return !shown
		},

		async quit(what) {
			await chain.renderer?.browser.close().catch(() => undefined)
			chain.renderer = null

			const pids = target.mainProcesses().map(item => item.pid)

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
					await findings.check("sign out after the failure", () =>
						signOut(chain.page(), findings, credentials.email, artifacts, name)
					)
				}

				throw error
			}
		},

		async stagger() {
			const seconds = Math.min(Number(process.env["E2E_STAGGER_SECONDS"] ?? "0") || 0, STAGGER_MAX_S)

			if (seconds > 0) {
				console.log(`waiting ${String(seconds)} s before the sign-in (stagger)`)
				await sleep(seconds * 1000)
			}
		},

		async quietActivity(pairs, allowed, conflicts = {}) {
			const problems: string[] = []

			for (const pair of pairs) {
				const activity = await desktop<DesktopSyncActivity[]>(chain.page(), `window.desktop.sync.activity(${json(pair.id)}, 200)`)

				problems.push(
					...activity
						.filter(item => TRANSFER_KINDS.has(item.kind) && !allowed.has(`${pair.name}:${item.kind}:${item.relPath ?? ""}`))
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
