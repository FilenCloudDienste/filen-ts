import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopLockStatus, DesktopMountsResult, DesktopPrefs, DesktopServeCredentials, DesktopSyncPair } from "@filen/shared/desktop"
import { LEGACY_VERSION } from "../../legacy.ts"
import { fail, freePort, waitFor } from "../../support.ts"
import { desktop, sessionStatus, signOut, unlockThroughScreen } from "../app.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { LEGACY_DELTAS, LEGACY_EDITS, LEGACY_PAIRS, legacySideTree, type LegacyPairFixture, treeSnapshot, writeTree } from "../fixtures.ts"
import { launchDebuggable, type Launched } from "../launch.ts"
import {
	configureLegacy,
	LEGACY_ORIGIN,
	legacySignIn,
	legacySyncCounts,
	legacySyncHold,
	type LegacySyncPair,
	quitLegacy,
	watchLegacySync
} from "../legacyApp.ts"
import { filesHolding, keyringItems, mountedType, processesUnder, processStartMs, sha256Through, uninstallDeb } from "../linux.ts"
import { cloudSnapshot, diffSnapshots, localSnapshot, snapshotText, type Snapshot, type SnapshotNode } from "../snapshot.ts"
import { START_TIMEOUT_MS, tail, type UpdateOptions } from "../update.ts"
import { BIN_DIR, EXIT_TIMEOUT_MS, inventory, json, LIVE_TIMEOUT_MS, ok, openChain, quiet, readJson, SETUP_TIMEOUT_MS } from "./common.ts"

// Chain L at deep depth: the real 3.0.53 is signed in through its own page and given what a user sets up (prefs, a PIN
// with a lock timeout, the network drive, WebDAV and five sync pairs, one per mode, the dot-file and local-trash switches
// mixed), syncs until it settles, and quits. One file changes on disk and one in the cloud while it is closed. Its own
// updater then installs N from the loopback feed (its sync held for that launch, so the edits wait for N), and N must
// migrate everything invisibly: the account without a sign-in, the PIN, prefs and mounts, every pair with its mode,
// transferring nothing but the two edits. Then the user signs out and uninstalls.
//
// The assertion table (each one a finding):
//   L1   update path              the update scenario's own checks (scripts/ci/e2e/update.ts)
//   L2   signed in, no prompt     marker `imported` within 90 s with a stored stash; session.vault; no in-memory session;
//                                 session.get() present and no sign-in form once unlocked
//   L3   PIN migrated             N starts locked; the 3.x PIN unlocks through the lock screen
//   L4   prefs migrated           N starts hidden; prefs.get() minimizeToTray and startMinimized on
//   L5   mounts migrated          the drive at the 3.x mount point, running, a fixture read through it; WebDAV on the same
//                                 port with the 3.x credentials, answering them
//   L6   3.x secrets wiped        marker verified and wiped; rclone.conf gone; then purged: Local Storage and the old
//                                 IndexedDB gone, and no file under userData or the logs holds a secret the harness knows
//   L7   userData/sync kept       renamed to sync.migrated-<date>, its content unchanged
//   L8   every pair, same mode    five pairs by name: the mapped mode, the same local root and remote directory, running
//   L9   invisible                no review, hold, notice, root problem or issue; info only localTrashNowOn where local
//                                 trash was off; no import note, no mount notice, no dialog over the page
//   L10  only the two edits       disk and cloud over N's first passes: identities unchanged except the expected deltas
//                                 (LEGACY_DELTAS); N's activity and plans carry nothing else
//   L12  no bin traffic           the engine's bin empty or absent; no old local trash
//   L13  the page as served       crossOriginIsolated
//   L14  sync works afterwards    a new local file uploads
//   L15  sign-out and uninstall   session and drive gone; the user's directories intact
//
// The old app's tray and notifications are not observed (no D-Bus capture yet). Linux deb only so far.

const CONVERGE_TIMEOUT_MS = 6 * 60 * 1000
const MIGRATE_TIMEOUT_MS = 8 * 60 * 1000
const IMPORT_TIMEOUT_MS = 90_000
// Seconds of inactivity before the old app locks: long enough that it never does during the run.
const LOCK_TIMEOUT_S = 3600
const DOT_FILE_RULES = [".*", "!/.filenignore"]

function pairFixture(name: string): LegacyPairFixture {
	return LEGACY_PAIRS.find(pair => pair.name === name) ?? fail(`no pair ${name}`)
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

interface MigrationMarker {
	stage?: string
	volatileStash?: boolean
	wiped?: boolean
	purged?: boolean
}

interface ShellState {
	pairs?: { name: string; pairId: string | null; state: string; review: unknown }[]
}

export async function runLegacyDeep(options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<void> {
	const chain = await openChain("legacy", options, artifacts)
	const { findings, cloud, cloudDir, localDir, credentials, work, target, page, userData, rootOf, snapshotOf } = chain
	const pin = String(randomInt(100_000, 1_000_000))
	const webdav = { username: `e2e-${randomBytes(4).toString("hex")}`, password: randomBytes(18).toString("hex"), port: await freePort() }
	const mountPoint = `${localDir}-mnt`
	const edits = {
		local: { ...LEGACY_EDITS.local, sha256: sha256(LEGACY_EDITS.local.bytes) },
		cloud: { ...LEGACY_EDITS.cloud, sha256: sha256(LEGACY_EDITS.cloud.bytes) }
	}
	const marker = () => readJson(userData("migration.json")) as MigrationMarker | null
	const state: {
		legacy?: { launched: Launched; renderer: Renderer }
		apiKey?: string
		pairs?: LegacySyncPair[]
		syncDir?: Snapshot
		local?: Map<string, Snapshot>
		cloud?: Snapshot
	} = {}

	chain.secret(pin)
	chain.secret(webdav.password)

	const legacyPage = () => state.legacy?.renderer.page ?? fail("the old app's page is not connected")

	const setUp = async (): Promise<void> => {
		const launched = await launchDebuggable(target, true, chain.appOutput)

		state.legacy = { launched, renderer: await connectRenderer(launched.debugPort, LEGACY_ORIGIN, START_TIMEOUT_MS) }

		await chain.stagger()
		await findings.must(`sign in through the ${LEGACY_VERSION} form (one attempt)`, async () => {
			const account = await legacySignIn(legacyPage(), credentials.email, credentials.password, START_TIMEOUT_MS)

			state.apiKey = account.apiKey
			chain.secret(account.apiKey)

			return `signed in (userId ${String(account.userId)})`
		})

		await findings.must("fixtures: five pair trees, each seeded on one side", async () => {
			await cloud.mkdir(cloudDir)
			mkdirSync(mountPoint, { recursive: true })

			const pairs: LegacySyncPair[] = []

			for (const pair of LEGACY_PAIRS) {
				const remoteDir = `${cloudDir}/${pair.name}`

				if (pair.seed === "cloud") {
					const seed = path.join(work, "seed", pair.name)

					writeTree(seed, legacySideTree(pair, "cloud"))
					await cloud.upload(seed, remoteDir)
					mkdirSync(rootOf(pair.name), { recursive: true })
				} else {
					writeTree(rootOf(pair.name), legacySideTree(pair, "local"))
					await cloud.mkdir(remoteDir)
				}

				pairs.push({
					uuid: randomUUID(),
					name: pair.name,
					localPath: rootOf(pair.name),
					remotePath: `/${remoteDir}`,
					remoteParentUUID: await cloud.dirId(remoteDir),
					mode: pair.legacyMode,
					excludeDotFiles: pair.excludeDotFiles,
					paused: false,
					localTrashDisabled: pair.localTrashDisabled
				})
			}

			state.pairs = pairs

			return `${String(pairs.length)} pairs under ${localDir} and ${cloudDir}`
		})

		await findings.must(`${LEGACY_VERSION}: prefs, PIN, network drive, WebDAV and the pairs set as its settings do`, async () => {
			await watchLegacySync(legacyPage())

			const keys = await configureLegacy(legacyPage(), {
				pairs: state.pairs ?? fail("no pairs"),
				drive: { mountPoint },
				webdav,
				pin,
				lockTimeout: LOCK_TIMEOUT_S
			})

			return `wrote ${keys.join(", ")}`
		})

		await findings.must(`${LEGACY_VERSION} converged: every pair quiet twice, both sides as expected`, async () => {
			const pairs = state.pairs ?? fail("no pairs")

			try {
				await waitFor(
					"the old app's pairs to converge",
					CONVERGE_TIMEOUT_MS,
					async () => {
						const { quiet: cycles } = await legacySyncCounts(legacyPage())

						if (!pairs.every(pair => (cycles[pair.uuid] ?? 0) >= 2)) {
							return null
						}

						for (const pair of LEGACY_PAIRS) {
							if (
								diffSnapshots(treeSnapshot(legacySideTree(pair, "local")), await snapshotOf(pair.name), { identity: false })
									.length > 0
							) {
								return null
							}

							const remoteSide = await cloudSnapshot(cloud, `${cloudDir}/${pair.name}`, work)

							if (
								remoteSide === null ||
								diffSnapshots(treeSnapshot(legacySideTree(pair, "cloud")), remoteSide, { identity: false }).length > 0
							) {
								return null
							}
						}

						return true
					},
					15_000
				)
			} catch (error) {
				findings.attach("legacy-sync-messages.json", json(await legacySyncCounts(legacyPage())))

				for (const pair of LEGACY_PAIRS) {
					findings.attach(`legacy-converge-${pair.name}-local.jsonl`, snapshotText(await snapshotOf(pair.name)))
				}

				throw error
			}

			return json((await legacySyncCounts(legacyPage())).types)
		})

		await findings.must(`${LEGACY_VERSION}: the network drive is mounted and WebDAV answers`, async () => {
			const type = await waitFor("the old network drive to mount", SETUP_TIMEOUT_MS, async () => mountedType(mountPoint))
			const response = await fetch(`http://127.0.0.1:${String(webdav.port)}/`, {
				method: "PROPFIND",
				headers: { Depth: "1", Authorization: `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString("base64")}` },
				signal: AbortSignal.timeout(LIVE_TIMEOUT_MS)
			})

			if (!type.startsWith("fuse") || response.status !== 207) {
				fail(`drive ${type}, WebDAV PROPFIND HTTP ${String(response.status)}`)
			}

			return `${type} at ${mountPoint}; PROPFIND 207`
		})

		await findings.must(`${LEGACY_VERSION} quits through app.quit(), rclone with it`, async () => {
			const options = readJson(userData("options.v1.json")) as { minimizeToTray?: unknown; startMinimized?: unknown } | null

			if (options?.minimizeToTray !== true || options.startMinimized !== true) {
				fail(`options.v1.json: ${json(options)}`)
			}

			await state.legacy?.renderer.browser.close().catch(() => undefined)

			const exit = await quitLegacy(state.legacy?.launched ?? fail("not launched"), EXIT_TIMEOUT_MS)

			await waitFor(
				"the old app's processes to end",
				EXIT_TIMEOUT_MS,
				() => (processesUnder("/opt/Filen/").length === 0 ? true : null),
				1000
			)
			await waitFor("the old drive to unmount", EXIT_TIMEOUT_MS, async () => ((await mountedType(mountPoint)) === null ? true : null))
			delete state.legacy
			// Baseline A: the old app settled and closed. Its sync state is compared by content only.
			state.syncDir = await localSnapshot(userData("sync"))

			return exit
		})

		await findings.must("the closed-app edits: one file on disk, one in the cloud", async () => {
			const localFile = path.join(rootOf(edits.local.pair), ...edits.local.path.split("/"))
			const cloudFile = path.join(work, "edit-cloud.bin")

			writeFileSync(localFile, edits.local.bytes)
			writeFileSync(cloudFile, edits.cloud.bytes)
			await cloud.uploadFile(cloudFile, `${cloudDir}/${edits.cloud.pair}/${edits.cloud.path}`)

			// Baseline B: what N starts from.
			state.local = new Map()

			for (const pair of LEGACY_PAIRS) {
				state.local.set(pair.name, await snapshotOf(pair.name))
			}

			state.cloud = (await cloudSnapshot(cloud, cloudDir, work)) ?? fail(`${cloudDir} is gone`)
			findings.attach("legacy-baseline-cloud.jsonl", snapshotText(state.cloud))

			return `${edits.local.pair}/${edits.local.path} on disk, ${edits.cloud.pair}/${edits.cloud.path} in the cloud`
		})
	}

	const updateLaunch = async () => {
		const hold = await legacySyncHold()

		return {
			args: hold.args,
			started: async () => {
				await findings.must(`${LEGACY_VERSION}'s sync held for its update launch`, async () => {
					const dropped = await hold.started()

					return `worker wrapped; dropped so far: ${dropped.join(", ") || "none"}`
				})
			}
		}
	}

	// The expected-delta table checked against what is there now: a rule file holds the dot-file rules (and in the cloud,
	// the bytes of its local copy), an edit the edit's bytes. `now` is one pair's tree (`pair`), or with `pair` null the
	// chain's whole cloud directory.
	const checkDeltas = (side: "local" | "cloud", now: Snapshot, pair: string | null): string[] => {
		const problems: string[] = []

		for (const delta of LEGACY_DELTAS.filter(item => item.side === side && (pair === null || item.pair === pair))) {
			const node = now.get(pair === null ? `${delta.pair}/${delta.path}` : delta.path)
			const edit = edits.local.pair === delta.pair && edits.local.path === delta.path ? edits.local : edits.cloud

			if (node?.kind !== "file") {
				problems.push(`${side} ${delta.pair}/${delta.path}: missing`)
			} else if (delta.change === "edit" && node.sha256 !== edit.sha256) {
				problems.push(`${side} ${delta.pair}/${delta.path}: not the edit`)
			} else if (delta.change === "rules") {
				const local = readFileSync(path.join(rootOf(delta.pair), ".filenignore"), "utf8")
				const lines = local.split(/\r?\n/).map(line => line.trim())

				if (!DOT_FILE_RULES.every(rule => lines.includes(rule))) {
					problems.push(`${side} ${delta.pair}/.filenignore: without the dot-file rules`)
				} else if (side === "cloud" && node.sha256 !== sha256(Buffer.from(local))) {
					problems.push(`cloud ${delta.pair}/.filenignore: not its local copy`)
				}
			}
		}

		return problems
	}

	const findPairs = (overview: { pairs: DesktopSyncPair[] }) =>
		LEGACY_PAIRS.map(pair => ({ fixture: pair, found: overview.pairs.find(candidate => candidate.name === pair.name) }))

	const unlock = async (what: string): Promise<void> => {
		await findings.must(what, async () => {
			const locked = await waitFor("the lock status", START_TIMEOUT_MS, async () => {
				const status = await desktop<DesktopLockStatus>(page(), "window.desktop.lock.status()")

				return status.enabled ? status : null
			})

			if (!locked.locked) {
				fail(`not locked at start: ${json(locked)}`)
			}

			await unlockThroughScreen(page(), pin, START_TIMEOUT_MS)
			await waitFor("the unlock", SETUP_TIMEOUT_MS, async () =>
				(await desktop<DesktopLockStatus>(page(), "window.desktop.lock.status()")).locked ? null : true
			)

			return "locked at start; the PIN unlocks through the lock screen"
		})
	}

	const verify = async (): Promise<void> => {
		const relaunchedAt = Math.min(...target.mainProcesses().map(item => processStartMs(item.pid)))
		const engine = () => {
			const userId = marker() as { userId?: number } | null

			return userData("sync-engine", String(userId?.userId ?? ""))
		}

		// N as the updater relaunched it: hidden (startMinimized) and without a debugging port, so observed from outside.
		await findings.check("L2 the account, PIN and prefs imported within 90 s, the stash in secure storage", async () => {
			const read = await waitFor("the import", IMPORT_TIMEOUT_MS, () => {
				const current = marker()

				return current?.stage === "imported" || current?.stage === "verified" ? current : null
			})
			const missing = ["session.vault", "lock.vault", "prefs.json"].filter(name => !existsSync(userData(name)))

			if (read.volatileStash !== false || missing.length > 0) {
				fail(`marker ${json(read)}; missing ${missing.join(", ")}`)
			}

			if (tail(userData("logs", "main.log"), 4000).includes("keeping the session in memory only")) {
				fail("main.log: no secure storage, the session is kept in memory only")
			}

			return `stage ${String(read.stage)} ${String(Math.round((Date.now() - relaunchedAt) / 1000))} s after N started`
		})

		await findings.check("L10 N's first passes carry the two edits and nothing else (disk and cloud)", async () => {
			const shell = await waitFor(
				"every migrated pair to start",
				MIGRATE_TIMEOUT_MS,
				() => {
					const read = readJson(path.join(engine(), "shell.json")) as ShellState | null
					const review = read?.pairs?.find(pair => pair.state === "review")

					if (review !== undefined) {
						fail(`${review.name} waits in review: ${json(review.review)}`)
					}

					return read?.pairs?.length === LEGACY_PAIRS.length &&
						read.pairs.every(pair => pair.state === "active" && pair.pairId !== null)
						? read
						: null
				},
				5000
			)

			await quiet([...LEGACY_PAIRS.map(pair => rootOf(pair.name)), engine()])

			const problems: string[] = []

			for (const pair of LEGACY_PAIRS) {
				const allowed = LEGACY_DELTAS.filter(delta => delta.pair === pair.name && delta.side === "local").map(delta => delta.path)
				const now = await snapshotOf(pair.name)

				problems.push(
					...diffSnapshots(state.local?.get(pair.name) ?? new Map(), now, { identity: true, allowed }).map(
						line => `local ${pair.name}/${line}`
					),
					...checkDeltas("local", now, pair.name)
				)
			}

			const now = (await cloudSnapshot(cloud, cloudDir, work)) ?? new Map()
			const allowed = LEGACY_DELTAS.filter(delta => delta.side === "cloud").map(delta => `${delta.pair}/${delta.path}`)

			problems.push(
				...diffSnapshots(state.cloud ?? new Map(), now, { identity: true, allowed }).map(line => `cloud ${line}`),
				...checkDeltas("cloud", now, null)
			)

			if (problems.length > 0) {
				findings.attach("legacy-after-cloud.jsonl", snapshotText(now))
				fail(problems.join("; "))
			}

			return `${String(shell.pairs?.length)} pairs active; only the two edits and the rule files moved`
		})

		// The engine keeps a local file it replaces in its bin: the cloud edit's download leaves the old bytes there, and
		// nothing else may be in any bin.
		await findings.check("L12 the engine's bin holds only what the cloud edit replaced; no old local trash", async () => {
			const replaced = treeSnapshot(legacySideTree(pairFixture(edits.cloud.pair), "cloud")).get(edits.cloud.path)?.sha256
			const problems: string[] = []

			for (const pair of LEGACY_PAIRS) {
				const bin = path.join(rootOf(pair.name), BIN_DIR)
				const held = existsSync(bin) ? await localSnapshot(bin) : new Map<string, SnapshotNode>()

				for (const [relPath, node] of held) {
					if (node.kind === "file" && !(pair.name === edits.cloud.pair && node.sha256 === replaced)) {
						problems.push(`${pair.name}/${BIN_DIR}/${relPath}`)
					}
				}

				if (existsSync(path.join(rootOf(pair.name), ".filen.trash.local"))) {
					problems.push(`${pair.name}/.filen.trash.local`)
				}
			}

			if (problems.length > 0) {
				fail(problems.join(", "))
			}

			return "nothing in a bin but the replaced bytes of the cloud edit"
		})

		await findings.check("L7 userData/sync renamed to sync.migrated-<date>, its content kept", async () => {
			const retired = readdirSync(target.userData).filter(name => name.startsWith("sync.migrated-"))

			if (existsSync(userData("sync")) || retired.length !== 1) {
				fail(`sync ${existsSync(userData("sync")) ? "still there" : "gone"}; retired: ${retired.join(", ") || "none"}`)
			}

			const differences = diffSnapshots(state.syncDir ?? new Map(), await localSnapshot(userData(retired[0] ?? "")), {
				identity: false
			})

			if (differences.length > 0) {
				fail(differences.slice(0, 20).join("; "))
			}

			return `${retired[0] ?? ""}, unchanged`
		})

		await findings.must("N quits on SIGTERM and starts again with its debugging port", async () => {
			await chain.quit("N")

			const hidden = await chain.connect()

			await findings.check("L4 N starts hidden (startMinimized imported)", () => {
				if (!hidden) {
					fail("a window showed without being asked for")
				}

				return "no page until a second instance asked for the window"
			})

			return "connected"
		})

		await chain.signedOutOnFailure(async () => {
			chain.signedIn = (await sessionStatus(page())) === "present"

			await findings.check("L13 the page is cross-origin isolated", async () => {
				if ((await page().evaluate("globalThis.crossOriginIsolated")) !== true) {
					fail("crossOriginIsolated is not true")
				}

				return "true"
			})

			await findings.check("L2 the migrated session is there, no sign-in", () => {
				if (!chain.signedIn) {
					fail("session.get() reports no session")
				}

				return "present"
			})

			await unlock("L3 N starts locked; the 3.x PIN unlocks it")

			await findings.check("L2 no sign-in form once unlocked", async () => {
				if ((await page().getByLabel("Email", { exact: true }).count()) > 0) {
					fail("the sign-in form shows")
				}

				return "the shell, no sign-in form"
			})

			await findings.check("L6 the migration verified the account and wiped the 3.x secrets", async () => {
				const read = await waitFor("the migration to verify and wipe", SETUP_TIMEOUT_MS, () => {
					const current = marker()

					return current?.stage === "verified" && current.wiped === true ? current : null
				})

				if (existsSync(userData("rclone", "rclone.conf"))) {
					fail("userData/rclone/rclone.conf is still there")
				}

				return `stage ${String(read.stage)}, wiped; rclone.conf gone`
			})

			await findings.check("L4 prefs migrated", async () => {
				const prefs = await desktop<DesktopPrefs>(page(), "window.desktop.prefs.get()")

				if (!prefs.minimizeToTray || !prefs.startMinimized) {
					fail(json(prefs))
				}

				return json(prefs)
			})

			await findings.check("L5 the network drive runs at the 3.x mount point and reads the cloud edit", async () => {
				const drive = await waitFor("the drive to run", SETUP_TIMEOUT_MS, async () => {
					const read = (await chain.mountsOverview()).drive

					return read.state === "running" || read.state === "error" ? read : null
				})

				if (!drive.enabled || drive.state !== "running" || drive.mountPoint !== realpathSync(mountPoint) || drive.readOnly) {
					fail(json(drive))
				}

				const type = await mountedType(drive.mountPoint)
				const read = await sha256Through(
					path.join(drive.mountPoint, ...`${cloudDir}/${edits.cloud.pair}/${edits.cloud.path}`.split("/")),
					LIVE_TIMEOUT_MS
				)

				if (type === null || !type.startsWith("fuse") || read !== edits.cloud.sha256) {
					fail(
						`findmnt ${type ?? "not mounted"}; the cloud edit read through the drive ${read === edits.cloud.sha256 ? "matches" : "differs"}`
					)
				}

				return `${type} at ${drive.mountPoint}; the cloud edit reads back byte for byte`
			})

			await findings.check("L5 WebDAV on the 3.x port with the 3.x credentials", async () => {
				const serve = await waitFor("WebDAV to run", SETUP_TIMEOUT_MS, async () => {
					const found = (await chain.mountsOverview()).serves.find(candidate => candidate.protocol === "webdav")

					return found?.state === "running" || found?.state === "error" ? found : null
				})
				const credentials = ok(
					"credentials",
					await desktop<DesktopMountsResult<DesktopServeCredentials>>(page(), 'window.desktop.mounts.credentials("webdav")')
				)

				if (serve.state !== "running" || serve.port !== webdav.port || serve.url === null) {
					fail(json(serve))
				}

				if (credentials.kind !== "basic" || credentials.user !== webdav.username || credentials.password !== webdav.password) {
					fail("the credentials are not the 3.x ones")
				}

				const response = await fetch(serve.url, {
					method: "PROPFIND",
					headers: {
						Depth: "1",
						Authorization: `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString("base64")}`
					},
					signal: AbortSignal.timeout(LIVE_TIMEOUT_MS)
				})

				if (response.status !== 207) {
					fail(`PROPFIND: HTTP ${String(response.status)}`)
				}

				return `${serve.url}: PROPFIND 207 with the 3.x credentials`
			})

			const overview = await waitFor("the pairs to be idle", SETUP_TIMEOUT_MS, async () => {
				const read = await chain.syncOverview()

				return findPairs(read).every(({ found }) => found?.phase === "idle") ? read : null
			}).catch(() => chain.syncOverview())

			await findings.check("L8 every pair present with its mode, roots and running", () => {
				const problems = findPairs(overview).flatMap(({ fixture, found }) => {
					if (found === undefined) {
						return [`${fixture.name}: missing`]
					}

					const legacy = state.pairs?.find(pair => pair.name === fixture.name)
					const want = {
						mode: fixture.mode,
						localRoot: realpathSync(rootOf(fixture.name)),
						remoteRoot: legacy?.remoteParentUUID,
						paused: false
					}
					const got = { mode: found.mode, localRoot: found.localRoot, remoteRoot: found.remoteRoot, paused: found.paused }

					return json(want) === json(got) ? [] : [`${fixture.name}: ${json(got)}, expected ${json(want)}`]
				})

				if (overview.pairs.length !== LEGACY_PAIRS.length) {
					problems.push(`${String(overview.pairs.length)} pairs`)
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `${String(LEGACY_PAIRS.length)} pairs, modes mapped, roots kept`
			})

			await findings.check("L9 invisible: no review, hold, notice, issue, import note or dialog", async () => {
				const expectedInfo = (pair: LegacyPairFixture) => (pair.localTrashDisabled ? ["localTrashNowOn"] : [])
				const problems = findPairs(overview).flatMap(({ fixture, found }) =>
					found === undefined
						? []
						: [
								...(found.review === null ? [] : [`${fixture.name}: review ${json(found.review)}`]),
								...(found.holds.length === 0 ? [] : [`${fixture.name}: holds ${json(found.holds)}`]),
								...(found.notices.length === 0 ? [] : [`${fixture.name}: notices ${json(found.notices)}`]),
								...(found.rootProblem === null ? [] : [`${fixture.name}: root ${json(found.rootProblem)}`]),
								...(json(found.info) === json(expectedInfo(fixture)) ? [] : [`${fixture.name}: info ${json(found.info)}`]),
								...(Object.values(found.issues).every(count => count === 0)
									? []
									: [`${fixture.name}: issues ${json(found.issues)}`]),
								...(found.phase === "idle" ? [] : [`${fixture.name}: ${found.phase}`])
							]
				)
				const mounts = await chain.mountsOverview()
				const dialogs = await page().locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true }).allInnerTexts()

				if (overview.importNote !== null) {
					problems.push(`import note ${json(overview.importNote)}`)
				}

				if (mounts.notices.length > 0) {
					problems.push(`mount notices ${json(mounts.notices)}`)
				}

				problems.push(...dialogs.map(text => `dialog: ${text.replace(/\s+/g, " ").slice(0, 200)}`))

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return "nothing over the page; localTrashNowOn only where local trash was off"
			})

			const pairIds = findPairs(overview).flatMap(({ fixture, found }) =>
				found === undefined ? [] : [{ name: fixture.name, id: found.id }]
			)
			const allowed = new Set([
				`${edits.local.pair}:uploaded:${edits.local.path}`,
				`${edits.cloud.pair}:downloaded:${edits.cloud.path}`,
				`${edits.cloud.pair}:binned:${edits.cloud.path}`,
				...LEGACY_DELTAS.filter(delta => delta.side === "cloud" && delta.change === "rules").map(
					delta => `${delta.pair}:uploaded:.filenignore`
				)
			])

			await findings.check("L10 N's activity and plans carry nothing but the edits", () => chain.quietActivity(pairIds, allowed))

			await findings.must("N quits on SIGTERM and starts a third time", async () => {
				await chain.quit("N")
				await chain.connect()

				return "connected"
			})
			await unlock("the PIN unlocks the third launch")

			await findings.check("L6 the old origin's stores purged and no secret left on disk", () => {
				const read = marker()
				const left = [
					...(existsSync(userData("Local Storage")) ? ["Local Storage/"] : []),
					...(existsSync(userData("IndexedDB"))
						? readdirSync(userData("IndexedDB")).filter(name => name.startsWith("filendesktop_bundle_0."))
						: [])
				]

				if (read?.purged !== true || left.length > 0) {
					fail(`purged ${String(read?.purged)}; left: ${left.join(", ") || "nothing"}`)
				}

				const secrets = [
					state.apiKey ?? "",
					...chain.remote.masterKeys,
					chain.remote.privateKey.slice(64, 128),
					webdav.password,
					JSON.stringify(pin)
				]
				const hits = [target.userData, path.join(path.dirname(target.userData), "logs")].flatMap(root =>
					filesHolding(root, secrets).map(file => `${path.basename(root)}/${file}`)
				)

				if (hits.length > 0) {
					fail(`secrets in ${hits.join(", ")}`)
				}

				return "purged; no secret in userData or the logs"
			})

			await findings.check("steady state: the third launch transfers nothing", () => chain.quietActivity(pairIds, new Set()))

			await findings.check("L14 a live edit uploads", async () => {
				const name = `live-${randomBytes(4).toString("hex")}.txt`

				writeFileSync(path.join(rootOf("e2e-twoway"), name), `${name}\n`)
				await waitFor("the live file in the cloud", LIVE_TIMEOUT_MS, async () =>
					(await cloud.list(`${cloudDir}/e2e-twoway`, false))?.some(item => item.path === name) === true ? true : null
				)

				return `${name} uploaded`
			})

			await findings.must("L15 sign out through the account menu", async () => {
				const result = await signOut(page(), findings, credentials.email, artifacts, "legacy")

				chain.signedIn = false

				return result
			})
		})

		await findings.check("L15 the sign-out wiped the session and unmounted the drive", async () => {
			await waitFor("session.vault to be removed", SETUP_TIMEOUT_MS, () => (existsSync(userData("session.vault")) ? null : true))
			await waitFor("the drive to unmount", SETUP_TIMEOUT_MS, async () => ((await mountedType(mountPoint)) === null ? true : null))

			return "session.vault gone; nothing mounted"
		})
		findings.info("keyring items of Filen after the sign-out", (await keyringItems("Filen")).join("; ") || "none")
		findings.attach("legacy-userdata-after-sign-out.txt", inventory(target.userData))

		const kept = new Map<string, Snapshot>()

		for (const pair of LEGACY_PAIRS) {
			kept.set(pair.name, await snapshotOf(pair.name))
		}

		await findings.must("N quits on SIGTERM", async () => {
			await chain.quit("N")

			return "exit code 0"
		})

		await findings.check("L15 apt-get remove and purge take the app and leave the user's directories", async () => {
			uninstallDeb()

			const changed: string[] = []

			for (const pair of LEGACY_PAIRS) {
				changed.push(
					...diffSnapshots(kept.get(pair.name) ?? new Map(), await snapshotOf(pair.name), { identity: true }).map(
						line => `${pair.name}/${line}`
					)
				)
			}

			if (changed.length > 0) {
				fail(changed.join("; "))
			}

			return "/opt/Filen gone; every pair directory intact"
		})
		findings.attach("legacy-userdata-after-uninstall.txt", inventory(path.dirname(target.userData)))
	}

	// The old app's page and inspector, if a setup step failed while it ran (the harness never leaves it running).
	const setUpOrClose = async (): Promise<void> => {
		try {
			await setUp()
		} finally {
			if (state.legacy !== undefined) {
				await state.legacy.renderer.browser.close().catch(() => undefined)
				await quitLegacy(state.legacy.launched, EXIT_TIMEOUT_MS).catch(() => undefined)
			}
		}
	}

	await chain.run(options, { beforeUpdate: setUpOrClose, afterUpdate: verify, updateLaunch })
}
