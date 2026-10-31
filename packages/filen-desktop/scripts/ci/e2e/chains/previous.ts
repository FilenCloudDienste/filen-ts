import { randomInt } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type {
	DesktopLockAttempt,
	DesktopLockStatus,
	DesktopMountsOverview,
	DesktopMountsResult,
	DesktopPrefs,
	DesktopServeCredentials,
	DesktopSyncActivity,
	DesktopSyncLocalRootChoice,
	DesktopSyncOverview,
	DesktopSyncPlan,
	DesktopSyncResult
} from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { errorMessage, fail, freePort, waitFor } from "../../support.ts"
import { APP_ORIGIN, desktop, desktopCall, pageText, sessionStatus, signIn, signOut, unlockThroughScreen } from "../app.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { openCloud, runDir } from "../cloud.ts"
import { createFindings } from "../findings.ts"
import { fixtureTree, PREVIOUS_DELTAS, PREVIOUS_PAIRS, treeSnapshot, writeTree } from "../fixtures.ts"
import { exitWithin, launchDebuggable, type Launched } from "../launch.ts"
import {
	chooseDirectory,
	coreReport,
	keyringItems,
	mountedType,
	processStartMs,
	screenDump,
	sha256Through,
	uninstallDeb
} from "../linux.ts"
import { redactor } from "../redact.ts"
import { harnessRemote, mask, secretsOf, takeCredentials } from "../session.ts"
import { cloudSnapshot, diffSnapshots, localSnapshot, snapshotText, type Snapshot } from "../snapshot.ts"
import { runUpdate, START_TIMEOUT_MS, tail, type UpdateOptions } from "../update.ts"

// Chain P at deep depth: N-1 on a clean machine is set up through its own page (the real sign-in form, the native
// folder chooser), syncs three pairs, and is updated to N by its own updater. N must then hold everything: no
// transfer or rewrite on either side, the session and PIN, the pairs, the drive and WebDAV, the preferences. Then the
// user signs out through the account menu and uninstalls; what remains is inventoried.
//
// The assertion table (each one a finding):
//   P1  update path                  the update scenario's own checks (scripts/ci/e2e/update.ts)
//   P2  session survives             session.vault kept, secure storage in use, session.get() present on N
//   P3  PIN and app lock             N starts locked; a wrong PIN is refused once; the PIN unlocks through the screen
//   P4  pairs keep running           disk and cloud unchanged over N's first launch (identities included); same pairs,
//                                    no review, holds or transfers; an empty plan; a live edit uploads
//   P5  mounts come back             drive running at the same point, a fixture read through it; WebDAV answers
//   P6  prefs kept                   prefs.get() as set on N-1
//   P7  the page boots as served     crossOriginIsolated
//   P8  sign-out wipes               session absent, session.vault gone, the drive unmounted
//   P9  uninstall                    the package gone, the user's pair directories intact
//
// Linux deb only so far: the folder chooser is driven with xdotool under Xvfb, and the session's secure storage is a
// gnome-keyring the workflow unlocks on the chain's own D-Bus session.

const CHOOSER_TITLE = "Choose a directory to sync"
const SETUP_TIMEOUT_MS = 2 * 60 * 1000
const CONVERGE_TIMEOUT_MS = 8 * 60 * 1000
const QUIET_MS = 30_000
const QUIET_MAX_MS = 3 * 60 * 1000
const LIVE_TIMEOUT_MS = 2 * 60 * 1000
const EXIT_TIMEOUT_MS = 60_000
const STAGGER_MAX_S = 300
const PREFS: DesktopPrefs = { minimizeToTray: false, startMinimized: false, launchAtLogin: false, notifications: false }
// Activity that means the engine moved, created or removed something.
const TRANSFER_KINDS = new Set<DesktopSyncActivity["kind"]>([
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

interface PairState {
	name: string
	mode: string
	id: string
	localRoot: string
	remoteRoot: string
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch {
		return null
	}
}

function json(value: unknown): string {
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
function newestWrite(dir: string): number {
	let newest = 0

	for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true, recursive: true }) : []) {
		if (entry.isFile()) {
			newest = Math.max(newest, statSync(path.join(entry.parentPath, entry.name), { throwIfNoEntry: false })?.mtimeMs ?? 0)
		}
	}

	return newest
}

// Until nothing under `dirs` changed for QUIET_MS, at most QUIET_MAX_MS.
async function quiet(dirs: readonly string[]): Promise<void> {
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
function ok<T>(what: string, result: DesktopSyncResult<T> | DesktopMountsResult<T>): T {
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

export async function runPreviousDeep(options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<void> {
	const { target, work } = options

	if (target.platform !== "linux" || target.format !== "deb") {
		fail("the deep N-1 -> N chain runs on Linux deb only so far")
	}

	const credentials = takeCredentials()
	const remote = harnessRemote(credentials)
	const pin = String(randomInt(100_000, 1_000_000))
	const secrets = [credentials.email, credentials.password, pin, ...secretsOf(remote)]

	mask([pin])

	const findings = createFindings("previous", artifacts, text => redactor(secrets)(text))
	const cloud = await openCloud(remote, work)
	const entry = `${target.platform}-${options.arch}-${target.format}`
	const cloudDir = `${runDir()}/${entry}/previous`
	const localDir = path.join(os.homedir(), "FilenE2E", path.posix.basename(runDir()), "previous")
	const trees = new Map(PREVIOUS_PAIRS.map(pair => [pair.name, fixtureTree(`previous/${pair.name}`, false)]))
	const rootOf = (name: string) => path.join(localDir, name)
	// The engine's own bin is not the user's tree.
	const snapshotOf = (name: string) => localSnapshot(rootOf(name), { skip: relPath => relPath === ".filen-sync-trash" })
	const userData = (...parts: string[]) => path.join(target.userData, ...parts)
	const state: {
		launched?: Launched
		renderer?: Renderer
		signedIn?: boolean
		pairs?: PairState[]
		local?: Map<string, Snapshot>
		cloud?: Snapshot
		drive?: string
		webdav?: { url: string; credentials: DesktopServeCredentials }
		vaultSize?: number
	} = {}

	const page = (): Page => state.renderer?.page ?? fail("no page connected")
	const syncOverview = () => desktop<DesktopSyncOverview>(page(), "window.desktop.sync.overview()")
	const mountsOverview = () => desktop<DesktopMountsOverview>(page(), "window.desktop.mounts.overview()")

	// The stdout and stderr of every launch, with Chromium's logging on (the updater's relaunch inherits it).
	const appOutput = path.join(work, "app-output.log")

	const connect = async (): Promise<void> => {
		mkdirSync(work, { recursive: true })
		state.launched = await launchDebuggable(target, false, appOutput)
		state.renderer = await connectRenderer(state.launched.debugPort, APP_ORIGIN, START_TIMEOUT_MS)
	}

	// Why a quit went wrong: the app's output and any core dump its main processes left (the updater's relaunch, which
	// is no child of the harness, reports its crash this way only).
	const quitEvidence = async (what: string, pids: readonly number[]): Promise<string[]> => {
		const cores: string[] = []

		for (const pid of pids) {
			const report = await coreReport(target.executable, pid)

			if (report !== null) {
				cores.push(report.slice(0, report.indexOf("\n")))
				findings.attach(`previous-${what}-core-${String(pid)}.txt`, report)
			}
		}

		findings.attach(`previous-${what}-output.log`, tail(appOutput, 3000))

		return cores
	}

	// SIGTERM quits the app gracefully on Linux (its own launch, or the one the updater relaunched).
	const quit = async (what: string): Promise<void> => {
		await state.renderer?.browser.close().catch(() => undefined)
		delete state.renderer

		const pids = target.mainProcesses().map(entry => entry.pid)

		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM")
			} catch {
				// Already gone.
			}
		}

		if (state.launched !== undefined && pids.includes(state.launched.child.pid ?? -1)) {
			const exit = await exitWithin(state.launched, EXIT_TIMEOUT_MS)

			if (exit === null || exit.code !== 0 || exit.signal !== null) {
				const cores = await quitEvidence(what, pids)

				fail(`${what} did not quit gracefully on SIGTERM: ${json(exit)}${cores.length > 0 ? ` (${cores.join(", ")})` : ""}`)
			}
		}

		await waitFor(`${what} to exit`, EXIT_TIMEOUT_MS, () => (target.mainProcesses().length === 0 ? true : null), 1000)
		delete state.launched

		const cores = await quitEvidence(what, pids)

		if (cores.length > 0) {
			fail(`${what} crashed on SIGTERM: ${cores.join(", ")}`)
		}
	}

	// A step that leaves a session behind on failure signs out through the page first (never left signed in).
	const signedOutOnFailure = async (step: () => Promise<void>): Promise<void> => {
		try {
			await step()
		} catch (error) {
			if (state.signedIn === true && state.renderer !== undefined) {
				await findings.check("sign out after the failure", () =>
					signOut(page(), findings, credentials.email, artifacts, "previous")
				)
			}

			throw error
		}
	}

	const setUp = async (): Promise<void> => {
		await connect()
		await findings.must("P0 a clean machine: sign-in screen, no session, migration skipped", async () => {
			await page().getByText("Sign in to Filen").waitFor({ state: "visible", timeout: START_TIMEOUT_MS })

			const status = await sessionStatus(page())
			const stage = await waitFor("the migration marker", SETUP_TIMEOUT_MS, () => {
				const marker = readJson(userData("migration.json"))

				return typeof marker === "object" && marker !== null && "stage" in marker ? String(marker.stage) : null
			})

			if (status !== "absent" || stage !== "skipped") {
				fail(`session ${status}, migration ${stage}`)
			}

			return `session ${status}, migration ${stage}`
		})

		// Deep jobs sign in some seconds apart (the plan's per-entry offset); logins are rate-limited per account.
		const stagger = Math.min(Number(process.env["E2E_STAGGER_SECONDS"] ?? "0") || 0, STAGGER_MAX_S)

		if (stagger > 0) {
			console.log(`waiting ${String(stagger)} s before the sign-in (stagger)`)
			await sleep(stagger * 1000)
		}

		await findings.must("sign in through the 4.x form (one attempt)", async () => {
			try {
				state.signedIn = true

				return await signIn(page(), credentials.email, credentials.password, START_TIMEOUT_MS)
			} catch (error) {
				findings.attach("previous-sign-in-page.txt", await pageText(page(), 4000))

				throw error
			}
		})

		await signedOutOnFailure(async () => {
			const remoteRoots = new Map<string, string>()

			await findings.must("fixtures: local trees and cloud trees", async () => {
				await cloud.mkdir(cloudDir)

				for (const pair of PREVIOUS_PAIRS) {
					const tree = trees.get(pair.name) ?? fail(`no tree for ${pair.name}`)
					const remoteDir = `${cloudDir}/${pair.name}`

					if (pair.seed === "cloud") {
						const seed = path.join(work, "seed", pair.name)

						writeTree(seed, tree)
						await cloud.upload(seed, remoteDir)
						mkdirSync(rootOf(pair.name), { recursive: true })
					} else {
						writeTree(rootOf(pair.name), tree)
						await cloud.mkdir(remoteDir)
					}

					remoteRoots.set(pair.name, await cloud.dirId(remoteDir))
				}

				return `${String(PREVIOUS_PAIRS.length)} pairs under ${localDir} and ${cloudDir}`
			})

			await findings.must("preferences set", async () => {
				const prefs = await desktop<DesktopPrefs>(page(), `window.desktop.prefs.set(${json(PREFS)})`)

				if (json(prefs) !== json({ ...prefs, ...PREFS })) {
					fail(`prefs.set returned ${json(prefs)}`)
				}

				return json(prefs)
			})

			await findings.must("the network drive runs at the default mount point", async () => {
				ok("setDrive", await desktop<DesktopMountsResult<null>>(page(), "window.desktop.mounts.setDrive({ enabled: true })"))

				const drive = await waitFor("the drive to run", SETUP_TIMEOUT_MS, async () => {
					const { drive } = await mountsOverview()

					if (drive.state === "error") {
						fail(`drive error: ${json(drive.error)}`)
					}

					return drive.state === "running" ? drive : null
				})

				state.drive = drive.mountPoint ?? fail("the running drive reports no mount point")

				return `running at ${state.drive}`
			})

			await findings.must("WebDAV serves on loopback with credentials", async () => {
				const port = await freePort()

				ok(
					"setServe",
					await desktop<DesktopMountsResult<null>>(
						page(),
						`window.desktop.mounts.setServe("webdav", ${json({ enabled: true, port })})`
					)
				)

				const serve = await waitFor("WebDAV to run", SETUP_TIMEOUT_MS, async () => {
					const found = (await mountsOverview()).serves.find(candidate => candidate.protocol === "webdav")

					if (found?.state === "error") {
						fail(`webdav error: ${json(found.error)}`)
					}

					return found?.state === "running" && found.url !== null ? found : null
				})
				const credentialsRead = ok(
					"credentials",
					await desktop<DesktopMountsResult<DesktopServeCredentials>>(page(), 'window.desktop.mounts.credentials("webdav")')
				)

				if (credentialsRead.kind !== "basic") {
					fail(`webdav credentials are ${credentialsRead.kind}`)
				}

				secrets.push(credentialsRead.password)
				mask([credentialsRead.password])
				state.webdav = { url: serve.url ?? "", credentials: credentialsRead }

				return `running at ${serve.url ?? ""}`
			})

			const pairs: PairState[] = []

			for (const pair of PREVIOUS_PAIRS) {
				await findings.must(`add pair ${pair.name} (${pair.mode}) through the native folder chooser`, async () => {
					const choice = desktop<DesktopSyncLocalRootChoice>(page(), "window.desktop.sync.chooseLocalDirectory()")

					void choice.catch(() => undefined)
					await chooseDirectory(CHOOSER_TITLE, rootOf(pair.name), path.join(artifacts, `previous-chooser-${pair.name}`))

					const chosen = await choice

					if (chosen.status !== "ok") {
						fail(`chooseLocalDirectory: ${json(chosen)} (the chooser's steps: previous-chooser-${pair.name}-*.png)`)
					}

					const remoteRoot = remoteRoots.get(pair.name) ?? fail(`no remote root for ${pair.name}`)
					const added = ok(
						"addPair",
						await desktop<DesktopSyncResult<{ pairId: string; plan: DesktopSyncPlan | null }>>(
							page(),
							`window.desktop.sync.addPair(${json({ localRootId: chosen.id, remoteRoot, mode: pair.mode, name: pair.name })})`
						)
					)

					// The page shows the dry run, then the user starts the pair.
					if (added.plan !== null) {
						await desktopCall(page(), `window.desktop.sync.releasePlan(${json(added.plan.planId)})`)
					}

					ok("startPair", await desktop<DesktopSyncResult<null>>(page(), `window.desktop.sync.startPair(${json(added.pairId)})`))
					pairs.push({ name: pair.name, mode: pair.mode, id: added.pairId, localRoot: chosen.path, remoteRoot })

					return `pair ${added.pairId} at ${chosen.path}`
				})
			}

			state.pairs = pairs

			await findings.must("every pair finished its first pass and both sides hold the tree", async () => {
				await waitFor(
					"the pairs to converge",
					CONVERGE_TIMEOUT_MS,
					async () => {
						const overview = await syncOverview()
						const settled = pairs.every(pair => {
							const found = overview.pairs.find(candidate => candidate.id === pair.id)

							return found?.phase === "idle" && found.lastSyncedAt !== null && found.review === null
						})

						if (!settled) {
							return null
						}

						for (const pair of PREVIOUS_PAIRS) {
							const expected = treeSnapshot(trees.get(pair.name) ?? fail(`no tree for ${pair.name}`))

							if (diffSnapshots(expected, await snapshotOf(pair.name), { identity: false }).length > 0) {
								return null
							}

							const remoteSide = await cloudSnapshot(cloud, `${cloudDir}/${pair.name}`, work)

							if (remoteSide === null || diffSnapshots(expected, remoteSide, { identity: false }).length > 0) {
								return null
							}
						}

						return true
					},
					15_000
				)

				return "converged"
			})

			// Baseline: what N must hold untouched.
			state.local = new Map()

			for (const pair of PREVIOUS_PAIRS) {
				state.local.set(pair.name, await snapshotOf(pair.name))
			}

			state.cloud = (await cloudSnapshot(cloud, cloudDir, work)) ?? fail(`${cloudDir} is gone`)
			state.vaultSize = statSync(userData("session.vault")).size
			findings.attach("previous-baseline-cloud.jsonl", snapshotText(state.cloud))

			await findings.must("PIN app lock set (last, as a user would)", async () => {
				const attempt = await desktop<DesktopLockAttempt>(page(), `window.desktop.lock.set(${json(pin)}, null)`)

				if (!attempt.ok) {
					fail(`lock.set refused: ${json(attempt)}`)
				}

				return "set"
			})

			await findings.must("N-1 quits on SIGTERM", async () => {
				await quit("N-1")

				return "exit code 0"
			})
		})
	}

	const verify = async (): Promise<void> => {
		const relaunchedAt = Math.min(...target.mainProcesses().map(entry => processStartMs(entry.pid)))
		const pairs = state.pairs ?? fail("no pairs were set up")

		// N as the updater relaunched it, without a debugging port: observed from outside only.
		await findings.check("P4 N's first launch neither transfers nor rewrites anything (disk and cloud)", async () => {
			// N's engine has opened its baseline (it writes on open) before its quiet counts as passes having run.
			await waitFor("N's sync engine to open its baseline", QUIET_MAX_MS, () =>
				newestWrite(userData("sync-engine")) > relaunchedAt ? true : null
			)
			await quiet([...PREVIOUS_PAIRS.map(pair => rootOf(pair.name)), userData("sync-engine")])

			const differences: string[] = []

			for (const pair of PREVIOUS_PAIRS) {
				const before = state.local?.get(pair.name) ?? fail(`no baseline for ${pair.name}`)

				differences.push(
					...diffSnapshots(before, await snapshotOf(pair.name), {
						identity: true,
						allowed: PREVIOUS_DELTAS[pair.name] ?? []
					}).map(line => `local ${pair.name}/${line}`)
				)
			}

			const after = await cloudSnapshot(cloud, cloudDir, work)

			differences.push(
				...diffSnapshots(state.cloud ?? fail("no cloud baseline"), after ?? new Map(), { identity: true }).map(
					line => `cloud ${line}`
				)
			)

			if (differences.length > 0) {
				fail(differences.join("; "))
			}

			return "every file's bytes and identity unchanged on both sides"
		})

		await findings.check("P2 session vault kept, in secure storage", () => {
			const vault = userData("session.vault")
			const log = tail(userData("logs", "main.log"), 2000)

			if (!existsSync(vault) || statSync(vault).size !== state.vaultSize) {
				fail(`session.vault ${existsSync(vault) ? `changed size (${String(statSync(vault).size)})` : "is gone"}`)
			}

			if (log.includes("keeping the session in memory only")) {
				fail("main.log: no secure storage, the session is kept in memory only")
			}

			return `session.vault ${String(state.vaultSize)} bytes, unchanged`
		})

		await findings.must("N quits on SIGTERM and starts again with its debugging port", async () => {
			await quit("N")
			await connect()

			return "connected"
		})

		await signedOutOnFailure(async () => {
			await findings.check("P7 the page is cross-origin isolated", async () => {
				if ((await page().evaluate("globalThis.crossOriginIsolated")) !== true) {
					fail("crossOriginIsolated is not true")
				}

				return "true"
			})

			await findings.check("P2 the session is still there, no sign-in", async () => {
				const status = await sessionStatus(page())

				if (status !== "present") {
					fail(`session.get() status: ${status}`)
				}

				return "present"
			})
			state.signedIn = true

			await findings.must("P3 N starts locked; a wrong PIN is refused once; the PIN unlocks through the lock screen", async () => {
				const locked = await waitFor("the lock status", START_TIMEOUT_MS, async () => {
					const status = await desktop<DesktopLockStatus>(page(), "window.desktop.lock.status()")

					return status.enabled ? status : null
				})

				if (!locked.locked) {
					fail(`not locked at start: ${json(locked)}`)
				}

				const wrong = `${String((Number(pin[0]) + 1) % 10)}${pin.slice(1)}`
				const refused = await desktop<DesktopLockAttempt>(page(), `window.desktop.lock.unlock(${json(wrong)})`)

				if (refused.ok || refused.retryAt !== null) {
					fail(`a wrong PIN: ${json(refused)}`)
				}

				await unlockThroughScreen(page(), pin, START_TIMEOUT_MS)
				await waitFor("the unlock", SETUP_TIMEOUT_MS, async () =>
					(await desktop<DesktopLockStatus>(page(), "window.desktop.lock.status()")).locked ? null : true
				)

				return "locked at start, wrong PIN refused without lockout, unlocked with the PIN"
			})

			await findings.check("P4 the same pairs, idle, nothing held or in review", async () => {
				const overview = await waitFor("the pairs to be idle", SETUP_TIMEOUT_MS, async () => {
					const read = await syncOverview()

					return pairs.every(pair => read.pairs.find(candidate => candidate.id === pair.id)?.phase === "idle") ? read : null
				})
				const problems = pairs.flatMap(pair => {
					const found = overview.pairs.find(candidate => candidate.id === pair.id)

					if (found === undefined) {
						return [`${pair.name}: gone`]
					}

					const now = { name: found.name, mode: found.mode, localRoot: found.localRoot, remoteRoot: found.remoteRoot }
					const then = { name: pair.name, mode: pair.mode, localRoot: pair.localRoot, remoteRoot: pair.remoteRoot }

					return [
						...(json(now) === json(then) ? [] : [`${pair.name}: ${json(now)} was ${json(then)}`]),
						...(found.paused ? [`${pair.name}: paused`] : []),
						...(found.review === null ? [] : [`${pair.name}: review ${json(found.review)}`]),
						...(found.holds.length === 0 ? [] : [`${pair.name}: holds ${json(found.holds)}`]),
						...(found.notices.length === 0 ? [] : [`${pair.name}: notices ${json(found.notices)}`]),
						...(found.rootProblem === null ? [] : [`${pair.name}: root ${json(found.rootProblem)}`])
					]
				})

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `${String(pairs.length)} pairs as before the update`
			})

			await findings.check("P4 no transfer in N's activity and an empty plan", async () => {
				const problems: string[] = []

				for (const pair of pairs) {
					const activity = await desktop<DesktopSyncActivity[]>(page(), `window.desktop.sync.activity(${json(pair.id)}, 200)`)
					const moved = activity.filter(item => TRANSFER_KINDS.has(item.kind))

					problems.push(...moved.map(item => `${pair.name}: ${item.kind} ${item.relPath ?? ""}`))

					const plan = ok(
						"plan",
						await desktop<DesktopSyncResult<DesktopSyncPlan | null>>(page(), `window.desktop.sync.plan(${json(pair.id)})`)
					)

					if (plan !== null) {
						await desktopCall(page(), `window.desktop.sync.releasePlan(${json(plan.planId)})`)

						const { actions, heldDeletions, conflicts, refused } = plan.summary

						if (actions !== 0 || heldDeletions !== 0 || conflicts !== 0 || refused !== null) {
							problems.push(`${pair.name}: plan ${json(plan.summary)}`)
						}
					}
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return "no transfer activity; every plan empty"
			})

			await findings.check("P4 a live edit on N uploads", async () => {
				const name = `live-${path.posix.basename(runDir())}.txt`

				writeFileSync(path.join(rootOf("e2e-twoway"), name), `${name}\n`)
				await waitFor("the live file in the cloud", LIVE_TIMEOUT_MS, async () =>
					(await cloud.list(`${cloudDir}/e2e-twoway`, false))?.some(item => item.path === name) === true ? true : null
				)

				return `${name} uploaded`
			})

			await findings.check("P5 the drive runs at the same mount point and reads a fixture", async () => {
				const { drive } = await mountsOverview()

				if (!drive.enabled || drive.state !== "running" || drive.mountPoint !== state.drive) {
					fail(json(drive))
				}

				const type = await mountedType(drive.mountPoint)

				if (type === null || !type.startsWith("fuse")) {
					fail(`findmnt: ${type ?? "not mounted"}`)
				}

				const file = path.join(drive.mountPoint, ...`${cloudDir}/e2e-r2l/media/blob.bin`.split("/"))
				const expected = treeSnapshot(trees.get("e2e-r2l") ?? fail("no tree")).get("media/blob.bin")?.sha256
				const read = await sha256Through(file, LIVE_TIMEOUT_MS)

				if (read !== expected) {
					fail(`media/blob.bin read through the drive hashes ${read}`)
				}

				return `${type} at ${drive.mountPoint}; a fixture reads back byte for byte`
			})

			await findings.check("P5 WebDAV answers with the unchanged credentials", async () => {
				const before = state.webdav ?? fail("no WebDAV baseline")
				const serve = (await mountsOverview()).serves.find(candidate => candidate.protocol === "webdav")
				const now = ok(
					"credentials",
					await desktop<DesktopMountsResult<DesktopServeCredentials>>(page(), 'window.desktop.mounts.credentials("webdav")')
				)

				if (serve?.state !== "running" || serve.url !== before.url) {
					fail(`webdav ${json(serve)}`)
				}

				if (json(now) !== json(before.credentials) || before.credentials.kind !== "basic") {
					fail("the credentials changed")
				}

				const response = await fetch(before.url, {
					method: "PROPFIND",
					headers: {
						Depth: "1",
						Authorization: `Basic ${Buffer.from(`${before.credentials.user}:${before.credentials.password}`).toString("base64")}`
					},
					signal: AbortSignal.timeout(LIVE_TIMEOUT_MS)
				})

				if (response.status !== 207) {
					fail(`PROPFIND: HTTP ${String(response.status)}`)
				}

				return `PROPFIND ${before.url}: 207`
			})

			await findings.check("P6 preferences kept", async () => {
				const prefs = await desktop<DesktopPrefs>(page(), "window.desktop.prefs.get()")

				if (json(prefs) !== json({ ...prefs, ...PREFS })) {
					fail(json(prefs))
				}

				return json(prefs)
			})

			await findings.must("P8 sign out through the account menu", async () => {
				const result = await signOut(page(), findings, credentials.email, artifacts, "previous")

				state.signedIn = false

				return result
			})
		})

		await findings.check("P8 the sign-out wiped the session and unmounted the drive", async () => {
			const vault = userData("session.vault")

			await waitFor("session.vault to be removed", SETUP_TIMEOUT_MS, () => (existsSync(vault) ? null : true))
			await waitFor("the drive to unmount", SETUP_TIMEOUT_MS, async () =>
				(await mountedType(state.drive ?? fail("no drive"))) === null ? true : null
			)

			return "session.vault gone; nothing mounted"
		})
		findings.info("keyring items of Filen after the sign-out", (await keyringItems("Filen")).join("; ") || "none")
		findings.attach("previous-userdata-after-sign-out.txt", inventory(target.userData))

		const kept = new Map<string, Snapshot>()

		for (const pair of PREVIOUS_PAIRS) {
			kept.set(pair.name, await snapshotOf(pair.name))
		}

		await findings.must("N quits on SIGTERM", async () => {
			await quit("N")

			return "exit code 0"
		})

		await findings.check("P9 apt-get remove and purge take the app and leave the user's directories", async () => {
			uninstallDeb()

			if (existsSync("/etc/apparmor.d/Filen")) {
				fail("/etc/apparmor.d/Filen is still there")
			}

			const changed: string[] = []

			for (const pair of PREVIOUS_PAIRS) {
				changed.push(
					...diffSnapshots(kept.get(pair.name) ?? new Map(), await snapshotOf(pair.name), { identity: true }).map(
						line => `${pair.name}/${line}`
					)
				)
			}

			if (changed.length > 0) {
				fail(changed.join("; "))
			}

			return "/opt/Filen and its AppArmor profile gone; every pair directory intact"
		})
		findings.attach("previous-userdata-after-uninstall.txt", inventory(path.dirname(target.userData)))
	}

	const beforeReset = async (): Promise<void> => {
		findings.attach("previous-main.log", tail(userData("logs", "main.log"), 1000))
		findings.attach("previous-output.log", tail(appOutput, 3000))
		await screenDump(path.join(artifacts, "previous-last-screen.png"))
		await state.renderer?.browser.close().catch(() => undefined)
	}

	try {
		await runUpdate({ ...options, hooks: { beforeUpdate: setUp, afterUpdate: verify, beforeReset } })
	} catch (error) {
		await findings.check("the chain ran to the end", () => fail(errorMessage(error)))
	} finally {
		await cloud.purge(cloudDir).catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))
	}

	findings.finish()
}

// Every path below `root` with its size, sorted; for the owner's review of what stays behind.
function inventory(root: string): string {
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
