import { randomInt } from "node:crypto"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type {
	DesktopLockAttempt,
	DesktopLockStatus,
	DesktopMountsResult,
	DesktopPrefs,
	DesktopServeCredentials,
	DesktopSyncLocalRootChoice,
	DesktopSyncPlan,
	DesktopSyncResult
} from "@filen/shared/desktop"
import { errorMessage, fail, freePort, waitFor } from "../../support.ts"
import {
	desktop,
	desktopCall,
	fileProviderState,
	fileProviderToggle,
	fileProviderUserEnabled,
	pageText,
	putOffKeysReminder,
	sessionStatus,
	signIn,
	signOut,
	unlockThroughScreen
} from "../app.ts"
import { runDir } from "../cloud.ts"
import { offlineBlockFor, runOfflineProbe } from "../spikes/offline.ts"
import { fixtureTree, PREVIOUS_DELTAS, PREVIOUS_PAIRS, treeSnapshot, writeTree } from "../fixtures.ts"
import { CHOOSER_BUDGET_MS } from "../os.ts"
import { cloudSnapshot, diffSnapshots, snapshotText, type Snapshot } from "../snapshot.ts"
import { START_TIMEOUT_MS, tail, type UpdateOptions } from "../update.ts"
import {
	inventory,
	json,
	LIVE_TIMEOUT_MS,
	newestWrite,
	ok,
	openChain,
	quiet,
	QUIET_MAX_MS,
	readJson,
	SETUP_TIMEOUT_MS,
	type SignOutWitness
} from "./common.ts"

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
//   P8  sign-out wipes               session absent, session.vault gone, the drive unmounted; the user's sync and drive
//                                    data, migration.stash, lock.vault and the logs gone; the next launch deletes the
//                                    browser profile before ready (signOut.pending then gone)
//   P9  uninstall                    the package gone, the user's pair directories intact
//   P10 Filen in Finder (macOS)      on N-1 before the PIN: supported, the domain registered (userEnabled reported:
//                                    a person switches it on), an off/on round trip; left off
//
// Linux deb, Windows NSIS and macOS dmg; what differs per OS (the native folder chooser, the drive as the OS sees it,
// quitting, uninstalling) is behind scripts/ci/e2e/os.ts.

const CHOOSER_TITLE = "Choose a directory to sync"
const CONVERGE_TIMEOUT_MS = 8 * 60 * 1000
const DOMAIN_TIMEOUT_MS = 60_000
const PREFS: DesktopPrefs = { minimizeToTray: false, startMinimized: false, launchAtLogin: false, notifications: false }

interface PairState {
	name: string
	mode: string
	id: string
	localRoot: string
	remoteRoot: string
}

export async function runPreviousDeep(options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<void> {
	const chain = await openChain("previous", options, artifacts)
	const { findings, cloud, cloudDir, localDir, credentials, work, target, page, userData, rootOf, snapshotOf, connect, quit } = chain
	const { syncOverview, mountsOverview, signedOutOnFailure } = chain
	const pin = String(randomInt(100_000, 1_000_000))
	const trees = new Map(PREVIOUS_PAIRS.map(pair => [pair.name, fixtureTree(`previous/${pair.name}`, false)]))
	const state: {
		pairs?: PairState[]
		local?: Map<string, Snapshot>
		cloud?: Snapshot
		drive?: string
		webdav?: { url: string; credentials: DesktopServeCredentials }
		vaultSize?: number
	} = {}

	chain.secret(pin)

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

		await chain.stagger()

		await findings.must("sign in through the 4.x form (one attempt)", async () => {
			try {
				chain.signedIn = true

				return await signIn(page(), credentials.email, credentials.password, START_TIMEOUT_MS)
			} catch (error) {
				findings.attach("previous-sign-in-page.txt", await pageText(page(), 4000))

				throw error
			}
		})

		// The startup reminder is modal over the shell; put off before anything else, so it covers nothing that follows.
		findings.info(
			"the master-key reminder after sign-in",
			await putOffKeysReminder(page(), 20_000).then(
				shown => (shown ? "shown; put off (Remind me later)" : "not shown within 20 s"),
				(error: unknown) => `shown, not put off: ${errorMessage(error)}`
			)
		)

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

				state.drive = chain.os.driveRoot(drive) ?? fail(`the running drive reports no location: ${json(drive)}`)

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

				chain.secret(credentialsRead.password)
				state.webdav = { url: serve.url ?? "", credentials: credentialsRead }

				return `running at ${serve.url ?? ""}`
			})

			const pairs: PairState[] = []

			for (const pair of PREVIOUS_PAIRS) {
				await findings.must(`add pair ${pair.name} (${pair.mode}) through the native folder chooser`, async () => {
					const evidence = path.join(artifacts, `previous-chooser-${pair.name}`)
					// The app's call returns once the dialog is answered or cancelled; the driver's own bound plus a margin.
					const choice = desktop<DesktopSyncLocalRootChoice>(
						page(),
						"window.desktop.sync.chooseLocalDirectory()",
						CHOOSER_BUDGET_MS
					)

					void choice.catch(() => undefined)
					await chain.os.chooseDirectory(CHOOSER_TITLE, rootOf(pair.name), evidence)

					const chosen = await choice.catch(async (error: unknown) => {
						await chain.os.screenDump(`${evidence}-no-answer.png`)

						throw error
					})

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

			// Off again before the PIN, which keeps it off; it replicates nothing the baseline holds.
			if (target.platform === "mac") {
				await findings.check("P10 Filen in Finder registers its domain and survives an off/on round trip", async () => {
					try {
						const before = await fileProviderState(page())

						if (!before.supported || before.translocated || before.lockBlocked || before.enabled) {
							fail(`state() ${json(before)}`)
						}

						await fileProviderToggle(page(), "enable")

						const first = await fileProviderUserEnabled(page(), DOMAIN_TIMEOUT_MS)

						await fileProviderToggle(page(), "disable")
						await fileProviderToggle(page(), "enable")

						const last = await fileProviderUserEnabled(page(), DOMAIN_TIMEOUT_MS)

						return `registered; userEnabled ${String(first)}, after the round trip ${String(last)}`
					} finally {
						findings.info(
							"Filen in Finder switched off before the PIN",
							await fileProviderToggle(page(), "disable").catch((error: unknown) => errorMessage(error))
						)
					}
				})
			}

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

			await findings.must("N-1 quits gracefully", async () => {
				await quit("N-1")

				return "exit code 0"
			})
		})
	}

	const verify = async (): Promise<void> => {
		// Set right before the sign-out, which the steps after it need.
		let witness: SignOutWitness | undefined
		const signedOutWith = () => witness ?? fail("no sign-out witness")

		const relaunchedAt = Math.min(...(await Promise.all(target.mainProcesses().map(entry => chain.os.processStartMs(entry.pid)))))
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

		// The offline spike (spikes/offline.ts) starts N through its block's wrapper for its probe only.
		const offline = process.env["E2E_OFFLINE_SPIKE"] === "1" ? offlineBlockFor(target) : null

		if (offline !== null) {
			await findings.must("offline spike: prepared", () => offline.prepare())
		}

		await findings.must("N quits gracefully and starts again with its debugging port", async () => {
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
			chain.signedIn = true

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

			await findings.check("P4 no transfer in N's activity and an empty plan", () => chain.quietActivity(pairs, new Set()))

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

				const root = chain.os.driveRoot(drive)

				if (!drive.enabled || drive.state !== "running" || root === null || root !== state.drive) {
					fail(json(drive))
				}

				const type = await chain.os.driveMounted(root)

				if (type === null) {
					fail(`nothing mounted at ${root}`)
				}

				const file = path.join(root, ...`${cloudDir}/e2e-r2l/media/blob.bin`.split("/"))
				const expected = treeSnapshot(trees.get("e2e-r2l") ?? fail("no tree")).get("media/blob.bin")?.sha256
				const read = await chain.os.sha256Through(file, LIVE_TIMEOUT_MS)

				if (read !== expected) {
					fail(`media/blob.bin read through the drive hashes ${read}`)
				}

				return `${type} at ${root}; a fixture reads back byte for byte`
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

			if (offline !== null) {
				await runOfflineProbe(chain, offline, {
					pairs,
					editPair: "e2e-twoway",
					editCloudDir: `${cloudDir}/e2e-twoway`,
					pin
				})
			}

			witness = await chain.beforeSignOut()

			await findings.must("P8 sign out through the account menu", async () => {
				const result = await signOut(page(), findings, credentials.email, artifacts, "previous")

				chain.signedIn = false

				return result
			})
		})

		await findings.check("P8 the sign-out wiped the session, the user's data and the PIN, and unmounted the drive", async () => {
			const vault = userData("session.vault")

			await waitFor("session.vault to be removed", SETUP_TIMEOUT_MS, () => (existsSync(vault) ? null : true))
			await waitFor("the drive to unmount", SETUP_TIMEOUT_MS, async () =>
				(await chain.os.driveMounted(state.drive ?? fail("no drive"))) === null ? true : null
			)

			return `session.vault gone; nothing mounted; ${await chain.signOutWiped(signedOutWith())}`
		})
		findings.info(
			"secret store items of Filen after the sign-out",
			(await chain.os.secretStoreItems(target.userData)).join("; ") || "none"
		)
		findings.attach("previous-userdata-after-sign-out.txt", inventory(target.userData))

		const kept = new Map<string, Snapshot>()

		for (const pair of PREVIOUS_PAIRS) {
			kept.set(pair.name, await snapshotOf(pair.name))
		}

		await findings.must("N quits gracefully", async () => {
			await quit("N")

			return "exit code 0"
		})
		await findings.check("P8 the next launch deletes the browser profile before ready", () => chain.profileWipedOnLaunch())
		await findings.must("N quits gracefully after the profile wipe", async () => {
			await quit("N-profile-wiped")

			return "exit code 0"
		})
		await findings.check("P8 old profile entries are gone and none holds a value from before the sign-out", () =>
			chain.profileHoldsNoOldValue(signedOutWith())
		)

		await findings.check("P9 the app uninstalled as a user does, the user's directories left", async () => {
			const removed = await chain.os.uninstall(target)

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

			return `${removed}; every pair directory intact`
		})
		findings.attach("previous-userdata-after-uninstall.txt", inventory(path.dirname(target.userData)))
	}

	await chain.run(options, { beforeUpdate: setUp, afterUpdate: verify })
}
