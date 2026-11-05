import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import type {
	DesktopLockStatus,
	DesktopMountsResult,
	DesktopPrefs,
	DesktopServeCredentials,
	DesktopSyncConflict,
	DesktopSyncEntries,
	DesktopSyncPair,
	DesktopSyncResult
} from "@filen/shared/desktop"
import { LEGACY_PIN, pinFor } from "../../legacy.ts"
import { errorMessage, fail, freePort, waitFor } from "../../support.ts"
import {
	desktop,
	keepBothThroughIssues,
	MASTER_KEYS_REMINDER,
	pageText,
	putOffKeysReminder,
	sessionStatus,
	signOut,
	unlockThroughScreen
} from "../app.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import {
	emptyFillActivity,
	LEGACY_CONFLICTS,
	LEGACY_DELTAS,
	LEGACY_EDITS,
	LEGACY_LOCAL_TRASH,
	legacyEmptyFills,
	legacyLocalTree,
	LEGACY_PAIRS,
	legacySideTree,
	type LegacyDelta,
	type LegacyPairFixture,
	treeSnapshot,
	writeTree
} from "../fixtures.ts"
import { keyringEncrypted } from "../keyringData.ts"
import { launchDebuggable, type Launched } from "../launch.ts"
import {
	configureLegacy,
	LEGACY_ORIGIN,
	legacySignIn,
	legacySyncCounts,
	legacySyncHold,
	type LegacySyncPair,
	quitLegacy,
	requireLegacyPrefs,
	watchLegacySync
} from "../legacyApp.ts"
import { crossCheck, describeLegacy, seedLegacy } from "../seed.ts"
import { cloudSnapshot, diffSnapshots, filesHolding, localSnapshot, snapshotText, type Snapshot, type SnapshotNode } from "../snapshot.ts"
import { keptAsFromToast } from "../syncUi.ts"
import { quietUpdater } from "../legacyHook.ts"
import { installedBy } from "../olderUpdate.ts"
import { legacyLogOf, START_TIMEOUT_MS, tail, type UpdateOptions } from "../update.ts"
import { windowsProcessesUnder } from "../windows.ts"
import {
	BIN_DIR,
	endLeftovers,
	EXIT_TIMEOUT_MS,
	inventory,
	json,
	LIVE_TIMEOUT_MS,
	ok,
	openChain,
	pidsOf,
	quiet,
	readJson,
	SETUP_TIMEOUT_MS,
	type SignOutWitness
} from "./common.ts"
import { firstRunProblems, legacyHolds } from "./legacyHolds.ts"
import { liveEditUploads } from "./offlineListing.ts"
import {
	BARE_PAIR,
	bareImported,
	driveImportedOff,
	endOrphanedRclone,
	fallbackImported,
	findingsFor,
	legacyNetworkDriveEntries,
	legacyNetworkDriveLeft,
	leftoversBeside,
	olderDrive,
	plantedHeld,
	plantedShape,
	readPlanted,
	sdkConfigShapeOf
} from "./older.ts"

// Chain L at deep depth: the real 3.0.53 is signed in through its own page (or seeded with the run's session where the
// plan says so: what its login stores, scripts/ci/e2e/seed.ts) and given what a user sets up (prefs, a PIN with a lock
// timeout, the network drive, WebDAV and five sync pairs, one per mode, the dot-file and local-trash switches mixed),
// syncs until it settles, and quits. One file changes on disk and one in the cloud while it is closed. Its own updater
// then installs N from the loopback feed (its sync held for that launch, so the edits wait for N), and N must
// migrate everything invisibly: the account without a sign-in, the PIN, prefs and mounts, every pair with its mode,
// downloading the cloud edit and holding the disk edit as a conflict (N imports none of the old sync history, so a
// two-way path changed on one side is a conflict), moving nothing else. Then the user signs out and uninstalls.
//
// The assertion table (each one a finding):
//   L1   update path              the update scenario's own checks (scripts/ci/e2e/update.ts)
//   L2   signed in, no prompt     marker `imported` within 90 s with a stored stash; session.vault (v11 on Linux); no
//                                 in-memory session; session.get() present and no sign-in form once unlocked
//   L3   PIN migrated             N starts locked; the 3.x PIN unlocks through the lock screen
//   L4   prefs migrated           N starts hidden; prefs.get() minimizeToTray and startMinimized on
//   L5   mounts migrated          the drive at the 3.x mount point, running, a fixture read through it; WebDAV on the same
//                                 port with the 3.x credentials, answering them; on Windows from 3.0.47 no rclone of its
//                                 network drive runs on (N ends the one an app.exit(0) left, main.log names it)
//   L6   3.x secrets wiped        marker verified and wiped; rclone.conf gone; the old logs (<appData>/@filen/logs)
//                                 deleted (logsDeleted); 3.0.47's network drive (<appData>/@filen/network-drive, which
//                                 @filen/cli shares) left in place; then purged: Local Storage and the old IndexedDB gone,
//                                 and no file under userData (or the logs, should they come back) holds a secret the
//                                 harness knows
//   L7   userData/sync kept       renamed to sync.migrated-<date>, its content unchanged
//   L8   every pair, same mode    five pairs by name: the mapped mode, the same local root and remote directory, running
//   L9   invisible                no review, hold, notice, root problem or issue; info only localTrashNowOn where local
//                                 trash was off; conflicts only as LEGACY_CONFLICTS; no import note, no mount notice, no
//                                 dialog over the page but the master-key reminder (put off)
//   L10  only the edits           disk and cloud over N's first passes: identities unchanged except the expected deltas
//                                 (LEGACY_DELTAS); exactly LEGACY_CONFLICTS held; N's activity and plans carry nothing else
//   L11  a conflict resolved      the held conflict resolved through the Issues tab with Keep both, its toast naming
//                                 the copy: the overview counts none, the disk and the cloud hold the cloud's bytes at the path and the edit as the
//                                 engine's copy (<stem>.old.<ext>), byte for byte; then nothing else transfers, plans empty
//   L12  the bins                 each pair's bin holds exactly 3.x's local trash (moved there, content intact) and what
//                                 the cloud edit replaced, under the day's bucket; neither ever in the cloud
//   L13  the page as served       crossOriginIsolated
//   L14  sync works afterwards    a new local file uploads, in the account's P11 turn so that no other entry's network
//                                 drop holds drive-write meanwhile (chains/offlineListing.ts liveEditUploads)
//   L15  sign-out and uninstall   session and drive gone; the user's sync and drive data, migration.stash, lock.vault
//                                 and the logs gone, an unfinished import ended; the next launch deletes the browser
//                                 profile before ready; the user's directories intact
//   L16  review card              a cloud file added while 3.x is closed holds e2e-l2c in review; its card, one-click
//                                 changes, Start syncing, the held deletion approved (chains/legacyHolds.ts)
//   L17  whole-drive pair         a paused drive-root pair from 3.x is refused with Remove pair only; removed, the drive
//                                 root and its directory unchanged (chains/legacyHolds.ts)
// L8, L9 and L10 expect e2e-l2c in review and the drive-root pair refused, as LEGACY_FIRST_RUN says.
//
// The old app's tray and notifications are not observed. Linux deb and AppImage, Windows NSIS and macOS dmg so far; what
// differs per OS is behind scripts/ci/e2e/os.ts.
//
// Gap 1 (scripts/ci/e2e/chains/older.ts): from 3.0.53 the pairs also carry two shapes older clients stored (L8, L9);
// the same chain runs from 3.0.47 (scenario `older`), without L11, L12 and L14 and with its drive as 3.0.47 leaves it.

const CONVERGE_TIMEOUT_MS = 6 * 60 * 1000
const MIGRATE_TIMEOUT_MS = 8 * 60 * 1000
const IMPORT_TIMEOUT_MS = 90_000
// Seconds of inactivity before the old app locks: long enough that it never does during the run.
const LOCK_TIMEOUT_S = 3600
const DOT_FILE_RULES = [".*", "!/.filenignore"]
const BIN_MARKER = ".filed-by-day"

function expectedConflicts(pair: string): number {
	return LEGACY_CONFLICTS[pair]?.length ?? 0
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

interface MigrationMarker {
	stage?: string
	volatileStash?: boolean
	wiped?: boolean
	logsDeleted?: boolean
	purged?: boolean
}

interface ShellState {
	pairs?: { name: string; pairId: string | null; state: string; review: unknown }[]
}

export async function runLegacyDeep(options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<void> {
	if (!["linux deb", "linux AppImage", "win nsis", "mac dmg"].includes(`${options.target.platform} ${options.target.format}`)) {
		fail("the deep 3.0.53 -> N chain runs on Linux deb and AppImage, Windows NSIS and macOS dmg only so far")
	}

	// The old release the chain starts from (3.0.53, or 3.0.47 for scenario `older`), and its install as it left it.
	const release = pinFor(options.scenario) ?? fail(`chain L starts from an old release, not from ${options.scenario}`)
	const LEGACY_VERSION = release.version
	const chain = await openChain(release === LEGACY_PIN ? "legacy" : options.scenario, options, artifacts)
	const { cloud, cloudDir, localDir, credentials, work, target, page, userData, rootOf, snapshotOf } = chain
	const findings = findingsFor(chain.findings, release, chain.name)
	const installed = installedBy(target, release)
	const holds = legacyHolds(chain, findings)
	const pin = String(randomInt(100_000, 1_000_000))
	const webdav = { username: `e2e-${randomBytes(4).toString("hex")}`, password: randomBytes(18).toString("hex"), port: await freePort() }
	// What 3.x's drive is set to (a mount point, or a letter on Windows) and where 4.x must then reach it.
	const drive = chain.os.legacyDrive(localDir)
	const edits = {
		local: { ...LEGACY_EDITS.local, sha256: sha256(LEGACY_EDITS.local.bytes) },
		cloud: { ...LEGACY_EDITS.cloud, sha256: sha256(LEGACY_EDITS.cloud.bytes) }
	}
	// The empty files the old client leaves out (none from 3.0.53), which N fills in, and every change N may make.
	const fills = legacyEmptyFills(release.syncsEmptyFiles)
	const deltas = [...LEGACY_DELTAS, ...fills]
	const marker = () => readJson(userData("migration.json")) as MigrationMarker | null
	// The old client's logs, beside userData.
	const legacyLogs = path.dirname(legacyLogOf(target))
	const state: {
		legacy?: { launched: Launched; renderer: Renderer }
		apiKey?: string
		pairs?: LegacySyncPair[]
		syncDir?: Snapshot
		local?: Map<string, Snapshot>
		cloud?: Snapshot
		// What each pair's old local trash directory held as 3.x left it (null where it had none).
		trash?: Map<string, Snapshot | null>
		// What 3.x's options.v1.json held of the prefs (requireLegacyPrefs).
		optionsFile?: string
		afterCloud?: Snapshot
		// Windows: the tray preference was switched off to quit and is to be put back.
		trayOff?: boolean
		// 3.0.47 turned its network drive off (its start failed).
		driveOff?: boolean
		// What <appData>/@filen/network-drive held once the old app quit (null: none); N leaves it (L6).
		networkDrive?: string[] | null
	} = {}

	chain.secret(pin)
	chain.secret(webdav.password)

	// What the old local trash directory of a pair holds (relative paths, content hashes); null when there is none. The
	// engine's first pass moves it into the pair's bin, so only its content is compared afterwards.
	const trashContents = async (pair: string): Promise<Snapshot | null> => {
		const dir = path.join(rootOf(pair), LEGACY_LOCAL_TRASH)

		return existsSync(dir) ? localSnapshot(dir) : null
	}

	const legacyPage = () => state.legacy?.renderer.page ?? fail("the old app's page is not connected")

	const setUp = async (): Promise<void> => {
		const launched = await launchDebuggable(installed, true, chain.appOutput)

		if (!release.hasE2eHook) {
			await findings.must(`${LEGACY_VERSION}'s updater kept off the production feed while it is set up`, async () =>
				quietUpdater(launched.inspectPort ?? fail("the old app runs without its inspector"))
			)
		}

		state.legacy = { launched, renderer: await connectRenderer(launched.debugPort, LEGACY_ORIGIN, START_TIMEOUT_MS) }

		await findings.must(`${LEGACY_VERSION} can sign in to the account`, () => {
			if (!release.authVersions.includes(chain.client.authVersion)) {
				fail(
					`the account uses auth v${String(chain.client.authVersion)}; ${LEGACY_VERSION} takes v${release.authVersions.join(", v")} only`
				)
			}

			return `auth v${String(chain.client.authVersion)}`
		})

		if (chain.signIn === "real") {
			await chain.stagger()
			await findings.must(`sign in through the ${LEGACY_VERSION} form (one attempt)`, async () => {
				const account = await legacySignIn(legacyPage(), credentials.email, credentials.password, START_TIMEOUT_MS)

				state.apiKey = account.apiKey
				chain.secret(account.apiKey)

				return `signed in (userId ${String(account.userId)})`
			})
			await findings.check(
				`${LEGACY_VERSION}'s stored account is what the seed stores, with the handed session's API key`,
				async () =>
					crossCheck(await describeLegacy(legacyPage(), chain.client.apiKey), sdkConfigShapeOf(release), text =>
						findings.attach("legacy-sdk-config-shape.json", text)
					)
			)
		} else {
			await findings.must(`${LEGACY_VERSION} signed in with the handed session (seeded, no login)`, async () => {
				const userId = await seedLegacy(legacyPage(), chain.client, START_TIMEOUT_MS)

				state.apiKey = chain.client.apiKey

				return `seeded its sdkConfig, desktopConfig and authed; the reloaded page took the account (userId ${String(userId)})`
			})
		}

		await findings.must("fixtures: five pair trees, each seeded on one side", async () => {
			await cloud.mkdir(cloudDir)

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
				drive: { mountPoint: drive.setting },
				webdav,
				pin,
				lockTimeout: LOCK_TIMEOUT_S,
				...(release === LEGACY_PIN ? { oldShape: plantedShape(state.pairs ?? [], chain.client.userId, localDir, cloudDir) } : {})
			})

			return `wrote ${keys.join(", ")}`
		})

		if (fills.length > 0) {
			findings.info(
				`${LEGACY_VERSION} leaves 0-byte files out`,
				`its @filen/sync skips them in both trees (reason "empty"), so it converges without ${fills.map(fill => `${fill.pair} ${fill.side} ${fill.path}`).join(", ")}; N must carry each (L10)`
			)
		}

		await findings.must(`${LEGACY_VERSION} converged: every pair quiet twice, both sides as expected`, async () => {
			const pairs = state.pairs ?? fail("no pairs")

			// What still differs, per pair and side; logged on every poll and kept for the evidence.
			let mismatch = "nothing compared yet"

			try {
				await waitFor(
					"the old app's pairs to converge",
					CONVERGE_TIMEOUT_MS,
					async () => {
						const { quiet: cycles } = await legacySyncCounts(legacyPage())
						const busy = pairs.filter(pair => (cycles[pair.uuid] ?? 0) < 2).map(pair => pair.name)
						const differences: string[] = []

						for (const pair of LEGACY_PAIRS) {
							differences.push(
								...diffSnapshots(
									treeSnapshot(legacyLocalTree(pair, release.syncsEmptyFiles)),
									await snapshotOf(pair.name),
									{
										identity: false
									}
								).map(line => `${pair.name} local: ${line}`)
							)

							const remoteSide = await cloudSnapshot(cloud, `${cloudDir}/${pair.name}`, work)

							differences.push(
								...(remoteSide === null
									? [`${pair.name} cloud: no directory`]
									: diffSnapshots(treeSnapshot(legacySideTree(pair, "cloud", release.syncsEmptyFiles)), remoteSide, {
											identity: false
										}).map(line => `${pair.name} cloud: ${line}`))
							)
						}

						mismatch = [...busy.map(name => `${name}: not quiet twice yet`), ...differences].join("\n") || "none"
						console.log(`3.x convergence: ${mismatch.split("\n").slice(0, 8).join("; ")}`)

						return busy.length === 0 && differences.length === 0 ? true : null
					},
					20_000
				)
			} catch (error) {
				const counts = await legacySyncCounts(legacyPage())
				const names = new Map(pairs.map(pair => [pair.uuid, pair.name]))

				findings.attach("legacy-converge-mismatch.txt", mismatch)
				findings.attach(
					"legacy-sync-messages.json",
					json({
						...counts,
						details: Object.fromEntries(
							Object.entries(counts.details).map(([key, value]) => {
								const [uuid = "", type = ""] = key.split(" ")

								return [`${names.get(uuid) ?? uuid} ${type}`, value]
							})
						)
					})
				)

				throw new Error(`${errorMessage(error)}; still differing: ${mismatch.split("\n").slice(0, 6).join("; ")}`, {
					cause: error
				})
			}

			return json((await legacySyncCounts(legacyPage())).types)
		})

		await findings.must(`${LEGACY_VERSION}: the network drive is mounted and WebDAV answers`, async () => {
			// Where 3.0.53 cannot mount (FUSE-T on macOS needs an administrator's install), its drive stays configured and
			// enabled, which is what migrates; 4.x then mounts it its own way (L5). 3.0.47 turns it off instead where its
			// start fails (scripts/ci/e2e/chains/older.ts), which migrates too.
			const older = release === LEGACY_PIN ? null : await olderDrive(legacyPage(), chain.os, drive.root, findings, SETUP_TIMEOUT_MS)

			state.driveOff = older?.off === true

			const type =
				older !== null
					? older.detail
					: chain.os.legacyDriveLive
						? await waitFor("the old network drive to mount", SETUP_TIMEOUT_MS, async () => chain.os.driveMounted(drive.root))
						: `configured only (3.0.53 cannot mount on this runner; ${(await chain.os.driveMounted(drive.root)) ?? "nothing"} mounted)`
			const response = await fetch(`http://127.0.0.1:${String(webdav.port)}/`, {
				method: "PROPFIND",
				headers: { Depth: "1", Authorization: `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString("base64")}` },
				signal: AbortSignal.timeout(LIVE_TIMEOUT_MS)
			})

			if (response.status !== 207) {
				fail(`drive ${type}, WebDAV PROPFIND HTTP ${String(response.status)}`)
			}

			return `${type} at ${drive.root}; PROPFIND 207`
		})

		// The prefs live in the page's localStorage; options.v1.json is main's mirror, which 3.x writes from two concurrent
		// read-merge-write calls (setMinimizeToTray, setStartMinimized), so one key can keep a stale value. 3.x reads only
		// startMinimized from the file, so that one must be true there (set once more through 3.x's own setter, alone, where
		// the race lost it); 4.x takes minimizeToTray from localStorage first, so the file's is recorded only, and L4's
		// evidence shows whether the stale path ran.
		await findings.must(
			`${LEGACY_VERSION} keeps the prefs on (localStorage; startMinimized in its options.v1.json mirror)`,
			async () => {
				state.optionsFile = await requireLegacyPrefs(legacyPage(), () => readJson(userData("options.v1.json")))

				return `localStorage both on; options.v1.json ${state.optionsFile}`
			}
		)

		await findings.check(`L17 setup: a paused whole-drive pair added to ${LEGACY_VERSION}`, () => holds.addRootPair(legacyPage()))

		if (release === LEGACY_PIN) {
			await findings.must(`${LEGACY_VERSION} still holds the planted shapes as it quits (L8, L9)`, async () => {
				const read = await readPlanted(legacyPage())

				findings.attach("legacy-planted-before-quit.json", json(read))

				return plantedHeld(
					read,
					chain.client.userId,
					state.pairs?.find(pair => pair.name === BARE_PAIR)?.uuid ?? fail(`no pair ${BARE_PAIR}`)
				)
			})
		}

		if (release.quit !== "app.quit()") {
			findings.info(
				`${LEGACY_VERSION}'s quit`,
				`it cancels app.quit() while minimize to tray is on (its window's close handler minimizes, nothing marks the quit); its tray's Exit is ${release.quit}, which ends its sync worker with the process (LegacyPin.quit)`
			)
		}

		await findings.must(`${LEGACY_VERSION} quits through ${release.quit}, rclone with it`, async () => {
			await state.legacy?.renderer.browser.close().catch(() => undefined)

			// D13 as the fallback, on every OS: whatever of the old app still runs a minute after its quit (its main
			// process, or a helper or watchdog it left) is hard-killed once nothing has been written for 30 s, and named.
			const settled = [...LEGACY_PAIRS.map(pair => rootOf(pair.name)), userData("sync")]
			const hardKill = async (left: readonly string[], why: string): Promise<void> => {
				await quiet(settled)
				await chain.os.forceKill(pidsOf(left))
				findings.info(
					`${LEGACY_VERSION}'s processes left after ${release.quit}`,
					`${left.join("; ")}: hard-killed after 30 s without writes (D13); ${why}`
				)
			}
			const exit = await quitLegacy(state.legacy?.launched ?? fail("not launched"), EXIT_TIMEOUT_MS, release.quit).catch(
				async (error: unknown) => {
					await hardKill(await chain.os.appProcesses(target), errorMessage(error))

					return "hard-killed (D13)"
				}
			)
			const lingering = await endLeftovers(chain.os, target, () => quiet(settled), EXIT_TIMEOUT_MS)

			if (lingering.length > 0) {
				findings.info(
					`${LEGACY_VERSION}'s processes left after ${release.quit}`,
					`${lingering.join("; ")}: hard-killed after 30 s without writes (D13); still running a minute after the main process ended`
				)
			}

			const orphaned = await endOrphanedRclone(release, target.platform, target.userData, windowsProcessesUnder, pids =>
				chain.os.forceKill(pids)
			)

			if (orphaned !== null) {
				findings.info(`${LEGACY_VERSION}'s rclone after ${release.quit} on Windows (LegacyPin.winRcloneOutlivesExit)`, orphaned)
			}

			state.networkDrive = legacyNetworkDriveEntries(target.userData)

			await waitFor("the old drive to unmount", EXIT_TIMEOUT_MS, async () =>
				(await chain.os.driveMounted(drive.root)) === null ? true : null
			)
			delete state.legacy
			// Baseline A: the old app settled and closed. Its sync state is compared by content only.
			state.syncDir = await localSnapshot(userData("sync"))

			return exit
		})

		await findings.check("L16 setup: a file added to e2e-l2c's cloud directory while 3.x is closed", () => holds.uploadWhileClosed())

		await findings.must("the closed-app edits: one file on disk, one in the cloud", async () => {
			const localFile = path.join(rootOf(edits.local.pair), ...edits.local.path.split("/"))
			const cloudFile = path.join(work, "edit-cloud.bin")

			writeFileSync(localFile, edits.local.bytes)
			writeFileSync(cloudFile, edits.cloud.bytes)
			await cloud.uploadFile(cloudFile, `${cloudDir}/${edits.cloud.pair}/${edits.cloud.path}`)

			// Baseline B: what N starts from.
			state.local = new Map()

			state.trash = new Map()

			for (const pair of LEGACY_PAIRS) {
				state.local.set(pair.name, await snapshotOf(pair.name))
				state.trash.set(pair.name, await trashContents(pair.name))
			}

			state.cloud = (await cloudSnapshot(cloud, cloudDir, work)) ?? fail(`${cloudDir} is gone`)
			findings.attach("legacy-baseline-cloud.jsonl", snapshotText(state.cloud))

			return `${edits.local.pair}/${edits.local.path} on disk, ${edits.cloud.pair}/${edits.cloud.path} in the cloud`
		})
	}

	const updateLaunch = async (feed: string) => {
		// A release without an E2E hook gets the feed and the install from the same hook.
		const hold = await legacySyncHold(installed.executable, release.hasE2eHook ? null : feed)

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

	// A left-out empty file N filled in: there, 0 bytes. `relPath` is its path in `now`.
	const fillProblem = (fill: LegacyDelta, now: Snapshot, relPath: string): string | null => {
		const node = now.get(relPath)

		return node?.kind === "file" && node.size === 0
			? null
			: `${fill.side} ${fill.pair}/${fill.path}: ${node === undefined ? "missing" : `a ${node.kind} of ${String(node.size)} bytes`}`
	}

	// The expected-delta table checked against what is there now: a rule file holds the dot-file rules (and in the cloud,
	// the bytes of its local copy), an edit the edit's bytes. `now` is one pair's tree (`pair`), or with `pair` null the
	// chain's whole cloud directory.
	const checkDeltas = (side: "local" | "cloud", now: Snapshot, pair: string | null): string[] => {
		const problems: string[] = []

		for (const delta of deltas.filter(item => item.side === side && (pair === null || item.pair === pair))) {
			const node = now.get(pair === null ? `${delta.pair}/${delta.path}` : delta.path)
			const edit = edits.local.pair === delta.pair && edits.local.path === delta.path ? edits.local : edits.cloud

			if (delta.change === "filled") {
				// A pair held in review has not run on N yet; its fill is checked once it started (L16).
				const problem =
					holds.hold(delta.pair) === null
						? fillProblem(delta, now, pair === null ? `${delta.pair}/${delta.path}` : delta.path)
						: null

				if (problem !== null) {
					problems.push(problem)
				}
			} else if (delta.change === "binned") {
				if (node !== undefined) {
					problems.push(`${side} ${delta.pair}/${delta.path}: still in the root`)
				}
			} else if (node?.kind !== "file") {
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

	// Quits N gracefully where the OS lets a harness do it. Windows has no signal and N keeps running in the tray while
	// minimizeToTray (imported on) holds: with a page, the preference goes off just before the window is closed (put back
	// after the next unlock); without one (the updater's own relaunch, started hidden), D13: a hard kill once nothing has
	// been written for 30 s, which the next launch then also proves recovery from.
	const quitN = async (what: string): Promise<void> => {
		if (target.platform === "win") {
			const turnedOff =
				chain.renderer !== null &&
				(await desktop(page(), "window.desktop.prefs.set({ minimizeToTray: false })").then(
					() => true,
					() => false
				))

			if (!turnedOff) {
				await chain.renderer?.browser.close().catch(() => undefined)
				chain.renderer = null
				await quiet([...LEGACY_PAIRS.map(pair => rootOf(pair.name)), userData("sync-engine")])
				await chain.os.forceKill(target.mainProcesses().map(item => item.pid))
				await waitFor(`${what} to end`, EXIT_TIMEOUT_MS, () => (target.mainProcesses().length === 0 ? true : null), 1000)
				chain.launched = null
				findings.info(`${what} quit`, "hard-killed after 30 s without writes (D13): a tray-only app with no window to close")

				return
			}

			state.trayOff = true
		}

		await chain.quit(what)
	}

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

			// The tray preference the last quit switched off (Windows), back as the migration left it.
			if (state.trayOff === true) {
				await desktop(page(), "window.desktop.prefs.set({ minimizeToTray: true })")
				state.trayOff = false
			}

			return "locked at start; the PIN unlocks through the lock screen"
		})
	}

	const verify = async (): Promise<void> => {
		// Set right before the sign-out, which the steps after it need.
		let witness: SignOutWitness | undefined
		let stageAtSignOut: string | undefined
		const signedOutWith = () => witness ?? fail("no sign-out witness")

		const relaunchedAt = Math.min(...(await Promise.all(target.mainProcesses().map(item => chain.os.processStartMs(item.pid)))))
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

		// Chromium's key from the Secret Service, not the hardcoded basic_text one (v10).
		if (target.platform === "linux") {
			await findings.check("L2 session.vault is encrypted with the keyring's key (v11)", () => {
				const vault = existsSync(userData("session.vault")) ? readFileSync(userData("session.vault")) : null

				if (!keyringEncrypted(vault)) {
					fail(
						`session.vault ${vault === null ? "missing" : `starts with ${JSON.stringify(vault.subarray(0, 3).toString("latin1"))}`}`
					)
				}

				return "starts with v11"
			})
		}

		await findings.check(
			"L10 N's first passes carry the cloud edit, hold the disk edit, move nothing else (disk and cloud)",
			async () => {
				const shell = await waitFor(
					"every migrated pair to start",
					MIGRATE_TIMEOUT_MS,
					() => {
						const read = readJson(path.join(engine(), "shell.json")) as ShellState | null

						// Active, but for the held and refused pairs of LEGACY_FIRST_RUN (chains/legacyHolds.ts).
						return holds.shellSettled(read?.pairs) ? read : null
					},
					5000
				)

				await quiet([...LEGACY_PAIRS.map(pair => rootOf(pair.name)), engine()])

				const problems: string[] = []

				for (const pair of LEGACY_PAIRS) {
					const allowed = deltas.filter(delta => delta.pair === pair.name && delta.side === "local").map(delta => delta.path)
					const now = await snapshotOf(pair.name)

					problems.push(
						...diffSnapshots(state.local?.get(pair.name) ?? new Map(), now, { identity: true, allowed }).map(
							line => `local ${pair.name}/${line}`
						),
						...checkDeltas("local", now, pair.name)
					)
				}

				const now = (await cloudSnapshot(cloud, cloudDir, work)) ?? new Map()

				state.afterCloud = now

				const allowed = deltas.filter(delta => delta.side === "cloud").map(delta => `${delta.pair}/${delta.path}`)

				problems.push(
					...diffSnapshots(state.cloud ?? new Map(), now, { identity: true, allowed }).map(line => `cloud ${line}`),
					...checkDeltas("cloud", now, null)
				)

				if (problems.length > 0) {
					findings.attach("legacy-after-cloud.jsonl", snapshotText(now))
					fail(problems.join("; "))
				}

				return `${String(shell.pairs?.length)} pairs active; only the two edits and the rule files moved`
			}
		)

		// Each pair's bin (<root>/.filen-sync-trash, filed by UTC day, its `.filed-by-day` marker beside the buckets) holds
		// exactly what the engine moved there: the old local trash with its content, and the local bytes the cloud edit's
		// download replaced, each at its tree position under the day's bucket. Neither ever reaches the cloud.
		await findings.check(
			"L12 the bins hold exactly the old local trash and what the cloud edit replaced; nothing in the cloud",
			async () => {
				const days = new Set([new Date(relaunchedAt).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)])
				const problems: string[] = []

				for (const pair of LEGACY_PAIRS) {
					const bin = path.join(rootOf(pair.name), BIN_DIR)
					const held = existsSync(bin) ? await localSnapshot(bin) : new Map<string, SnapshotNode>()
					const day = [...held.keys()].find(relPath => days.has(relPath)) ?? [...days][0] ?? ""
					const expected: Snapshot = new Map()
					const addDir = (relPath: string) => expected.set(relPath, { kind: "dir", size: 0, sha256: null, identity: null })
					const trash = state.trash?.get(pair.name) ?? null

					if (trash !== null) {
						addDir(`${day}/${LEGACY_LOCAL_TRASH}`)

						for (const [relPath, node] of trash) {
							expected.set(`${day}/${LEGACY_LOCAL_TRASH}/${relPath}`, { ...node, identity: null })
						}
					}

					if (pair.name === edits.cloud.pair) {
						const replaced = treeSnapshot(legacySideTree(pair, "cloud")).get(edits.cloud.path) ?? fail("no replaced file")
						const parts = edits.cloud.path.split("/")

						for (let depth = 1; depth < parts.length; depth++) {
							addDir(`${day}/${parts.slice(0, depth).join("/")}`)
						}

						expected.set(`${day}/${edits.cloud.path}`, replaced)
					}

					if (expected.size > 0) {
						addDir(day)
					}

					// The engine's mark that a bin is filed by day: written when a move creates the bin, and by its prune into
					// any bin that exists unmarked (filen-rs sync_engine/bin/mod.rs quarantine_local, prune_bin). Whether a
					// prune ran yet is the engine's business, so it is allowed in any bin, alone or beside the buckets; nothing
					// else extra is.
					held.delete(BIN_MARKER)

					problems.push(...diffSnapshots(expected, held, { identity: false }).map(line => `${pair.name}/${BIN_DIR}: ${line}`))
				}

				const cloudSide = state.afterCloud ?? (await cloudSnapshot(cloud, cloudDir, work)) ?? new Map()

				problems.push(
					...[...cloudSide.keys()]
						.filter(relPath => relPath.split("/").some((part: string) => part === LEGACY_LOCAL_TRASH || part === BIN_DIR))
						.map(relPath => `cloud ${relPath}`)
				)

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `the old local trash of ${String([...(state.trash?.values() ?? [])].filter(value => value !== null).length)} pairs and the replaced bytes of the cloud edit in today's bucket; none in the cloud`
			}
		)

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

		await findings.must("N quits and starts again with its debugging port", async () => {
			await quitN("N")

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

			await findings.check(
				"L6 the migration verified the account, wiped the 3.x secrets and deleted its logs, its network drive left in place",
				async () => {
					const read = await waitFor("the migration to verify, wipe and delete the old logs", SETUP_TIMEOUT_MS, () => {
						const current = marker()

						return current?.stage === "verified" && current.wiped === true && current.logsDeleted === true ? current : null
					})

					if (existsSync(userData("rclone", "rclone.conf"))) {
						fail("userData/rclone/rclone.conf is still there")
					}

					if (existsSync(legacyLogs)) {
						fail(`${legacyLogs} is still there`)
					}

					const mainLog = tail(userData("logs", "main.log"), 4000)

					if (!mainLog.includes("migration: the old client's logs were deleted")) {
						fail("main.log does not log the old logs' deletion")
					}

					const networkDrive = legacyNetworkDriveLeft(target.userData, state.networkDrive ?? null)

					if (!readdirSync(target.userData).some(name => name.startsWith("sync.migrated-"))) {
						fail("no sync.migrated-* in userData")
					}

					return `stage ${String(read.stage)}, wiped, logsDeleted; rclone.conf and @filen/logs gone; ${networkDrive}; sync.migrated-* kept`
				}
			)

			await findings.check("L4 prefs migrated", async () => {
				const prefs = await desktop<DesktopPrefs>(page(), "window.desktop.prefs.get()")

				if (!prefs.minimizeToTray || !prefs.startMinimized) {
					fail(json(prefs))
				}

				return `${json(prefs)}; 3.x's options.v1.json held ${state.optionsFile ?? "nothing read"}`
			})

			await findings.check("L5 the network drive runs at the 3.x mount point and reads the cloud edit", async () => {
				if (state.driveOff === true) {
					return driveImportedOff(() => chain.mountsOverview(), chain.os, drive.root)
				}

				const current = await waitFor("the drive to run", SETUP_TIMEOUT_MS, async () => {
					const read = (await chain.mountsOverview()).drive

					return read.state === "running" || read.state === "error" ? read : null
				})

				const root = chain.os.driveRoot(current)

				if (!current.enabled || current.state !== "running" || root !== drive.root || current.readOnly) {
					fail(json(current))
				}

				const type = await chain.os.driveMounted(root)
				const read = await chain.os.sha256Through(
					path.join(root, ...`${cloudDir}/${edits.cloud.pair}/${edits.cloud.path}`.split("/")),
					LIVE_TIMEOUT_MS
				)

				if (type === null || read !== edits.cloud.sha256) {
					fail(
						`${type ?? "nothing"} mounted; the cloud edit read through the drive ${read === edits.cloud.sha256 ? "matches" : "differs"}`
					)
				}

				return `${type} at ${root}; the cloud edit reads back byte for byte`
			})

			if (target.platform === "win" && release.winRcloneOutlivesExit) {
				await findings.check(`L5 no rclone of ${LEGACY_VERSION}'s network drive runs on beside N's drive`, async () => {
					const dir = path.join(path.dirname(target.userData), "network-drive")
					const left = await windowsProcessesUnder(dir)
					const logged = tail(userData("logs", "main.log"), 4000)
						.split(/\r?\n/)
						.filter(line => line.includes("rclone 3.0.47") || line.includes("other filen rclone"))

					if (left.length > 0) {
						fail(`${left.join("; ")} still running; main.log: ${logged.join("; ") || "nothing"}`)
					}

					return `none; main.log: ${logged.join("; ") || "nothing ended (none ran on when N started)"}`
				})
			}

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

				return findPairs(read).every(({ fixture, found }) => found?.phase === (holds.hold(fixture.name)?.phase ?? "idle"))
					? read
					: null
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
						paused: holds.hold(fixture.name)?.paused ?? false
					}
					const got = { mode: found.mode, localRoot: found.localRoot, remoteRoot: found.remoteRoot, paused: found.paused }

					return json(want) === json(got) ? [] : [`${fixture.name}: ${json(got)}, expected ${json(want)}`]
				})

				if (overview.pairs.length !== LEGACY_PAIRS.length + holds.extraPairs()) {
					problems.push(`${String(overview.pairs.length)} pairs`)
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `${String(LEGACY_PAIRS.length)} pairs, modes mapped, roots kept`
			})

			if (release === LEGACY_PIN) {
				await findings.check(
					"L8 pairs stored in desktopConfig only (before 3.0.39) import for the signed-in account, another account's do not",
					() => fallbackImported(overview, localDir)
				)
			}

			await findings.check("L9 invisible: no review, hold, notice, issue, import note or dialog", async () => {
				const expectedInfo = (pair: LegacyPairFixture) => (pair.localTrashDisabled ? ["localTrashNowOn"] : [])
				const problems = findPairs(overview).flatMap(({ fixture, found }) =>
					found === undefined
						? []
						: [
								...firstRunProblems(fixture.name, found, holds.hold(fixture.name)),
								...(found.holds.length === 0 ? [] : [`${fixture.name}: holds ${json(found.holds)}`]),
								...(found.notices.length === 0 ? [] : [`${fixture.name}: notices ${json(found.notices)}`]),
								...(found.rootProblem === null ? [] : [`${fixture.name}: root ${json(found.rootProblem)}`]),
								...(json(found.info) === json(expectedInfo(fixture)) ? [] : [`${fixture.name}: info ${json(found.info)}`]),
								...(json(found.issues) ===
								json({
									...found.issues,
									conflicts: expectedConflicts(fixture.name),
									heldDeletions: 0,
									unsyncable: 0,
									failed: 0
								})
									? []
									: [`${fixture.name}: issues ${json(found.issues)}`])
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

				// The one dialog a migrated session may show: the startup reminder to back up the master keys (owner decision),
				// put off with its own "Remind me later" so it covers nothing the later steps use.
				const reminder = dialogs.filter(text => text.trim().startsWith(MASTER_KEYS_REMINDER))

				problems.push(
					...dialogs
						.filter(text => !text.trim().startsWith(MASTER_KEYS_REMINDER))
						.map(text => `dialog: ${text.replace(/\s+/g, " ").slice(0, 200)}`)
				)

				if (reminder.length > 0) {
					await putOffKeysReminder(page(), 10_000)
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `nothing over the page${reminder.length > 0 ? " but the master-key reminder (put off)" : ""}; localTrashNowOn only where local trash was off; conflicts only as expected`
			})

			if (release === LEGACY_PIN) {
				await findings.check("L9 the pair stored without excludeDotFiles and localTrashDisabled imports both as off", () =>
					bareImported(overview, rootOf(BARE_PAIR))
				)
			}

			const pairIds = findPairs(overview).flatMap(({ fixture, found }) =>
				found === undefined ? [] : [{ name: fixture.name, id: found.id }]
			)
			const conflictActivity = Object.entries(LEGACY_CONFLICTS).flatMap(([pair, paths]) =>
				paths.map(relPath => `${pair}:conflict:${relPath}`)
			)
			const conflictCounts = Object.fromEntries(LEGACY_PAIRS.map(pair => [pair.name, expectedConflicts(pair.name)]))
			const allowed = new Set([
				`${edits.cloud.pair}:downloaded:${edits.cloud.path}`,
				`${edits.cloud.pair}:binned:${edits.cloud.path}`,
				...conflictActivity,
				...LEGACY_DELTAS.filter(delta => delta.change === "binned").map(delta => `${delta.pair}:binned:${delta.path}`),
				...LEGACY_DELTAS.filter(delta => delta.side === "cloud" && delta.change === "rules").map(
					delta => `${delta.pair}:uploaded:.filenignore`
				),
				...fills.map(emptyFillActivity)
			])

			await findings.check("L10 N's activity and plans carry nothing but the edits and the expected conflicts", () =>
				chain.quietActivity(
					pairIds.filter(pair => holds.hold(pair.name) === null),
					allowed,
					conflictCounts
				)
			)
			await findings.check("L10 a pair held in review plans exactly its held deletions", () => holds.heldPlans(pairIds, fills))

			await findings.check("L10 exactly the expected conflicts are held, both sides kept", async () => {
				const problems: string[] = []

				for (const { name, id } of pairIds) {
					const held = ok(
						"conflicts",
						await desktop<DesktopSyncResult<DesktopSyncEntries<DesktopSyncConflict>>>(
							page(),
							`window.desktop.sync.conflicts(${json(id)}, 0, 50)`
						)
					)
					const want = LEGACY_CONFLICTS[name] ?? []
					const got = held.entries.map(entry => `${entry.relPath} (${String(entry.local)}/${String(entry.remote)})`)

					if (json(got) !== json(want.map(relPath => `${relPath} (file/file)`)) || held.total !== want.length) {
						problems.push(`${name}: ${json(got)} of ${String(held.total)}, expected ${json(want)}`)
					}
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `held: ${conflictActivity.join(", ")}; the disk keeps the edit, the cloud the old bytes`
			})

			await holds.run(pairIds)

			// Where a pair waited in review (L16), N's first pass on it ran only now.
			if (fills.length > 0) {
				await findings.check(`L10 N carries the 0-byte files ${LEGACY_VERSION} left out, every pair`, async () => {
					let problems: string[] = []

					return waitFor(
						"every left-out empty file on its other side",
						SETUP_TIMEOUT_MS,
						async () => {
							const remote = (await cloudSnapshot(cloud, cloudDir, work)) ?? new Map()

							problems = []

							for (const fill of fills) {
								const problem =
									fill.side === "cloud"
										? fillProblem(fill, remote, `${fill.pair}/${fill.path}`)
										: fillProblem(fill, await snapshotOf(fill.pair), fill.path)

								if (problem !== null) {
									problems.push(problem)
								}
							}

							return problems.length === 0 ? fills.map(fill => `${fill.pair} ${fill.side} ${fill.path}`).join(", ") : null
						},
						15_000
					).catch((error: unknown) => fail(`${errorMessage(error)}; ${problems.join("; ")}`))
				})
			}

			await findings.must("N quits on SIGTERM and starts a third time", async () => {
				await quitN("N")
				await chain.connect()

				return "connected"
			})
			await unlock("the PIN unlocks the third launch")

			await findings.check("L6 the old origin's stores purged and no secret left on disk", () => {
				const read = marker()
				// The store is deleted before ready and the new page creates it again for its own origin, so only the old
				// origin's entries count (Chromium writes the origin into each of its keys).
				const left = [
					...filesHolding(userData("Local Storage"), [LEGACY_ORIGIN]).map(file => `Local Storage/${file}`),
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
				const hits = [target.userData, legacyLogs].flatMap(root =>
					filesHolding(root, secrets).map(file => `${path.basename(root)}/${file}`)
				)

				if (hits.length > 0) {
					fail(`secrets in ${hits.join(", ")}`)
				}

				return "purged; no secret in userData (the old logs are gone)"
			})

			// Keep both renames this device's copy aside (sdk-rs ConflictResolution::KeepBoth: `<stem>.old.<ext>`, `.old.N`
			// on a collision), which uploads, and takes the cloud's bytes at the path.
			const conflict = edits.local
			let keptCopy: string | null = null

			await findings.check("L11 the held conflict resolved through the Issues tab (Keep both)", async () => {
				const id = pairIds.find(pair => pair.name === conflict.pair)?.id ?? fail(`no pair ${conflict.pair}`)
				const cloudBytes =
					state.cloud?.get(`${conflict.pair}/${conflict.path}`)?.sha256 ?? fail("no cloud baseline for the conflict")

				const { putOff, toast } = await keepBothThroughIssues(page(), conflict.pair, conflict.path, SETUP_TIMEOUT_MS).catch(
					async (error: unknown) => {
						findings.attach("legacy-issues-page.txt", await pageText(page(), 4000))
						await chain.os.screenDump(path.join(chain.artifacts, "legacy-issues-page.png"))

						throw error
					}
				)

				findings.info(
					"L11 the master-key reminder over the Issues path",
					putOff === 0 ? "not shown" : `put off ${String(putOff)} time(s)`
				)
				await waitFor("the overview to count no conflict", SETUP_TIMEOUT_MS, async () =>
					(await chain.syncOverview()).pairs.find(pair => pair.id === id)?.issues.conflicts === 0 ? true : null
				)

				const dir = path.posix.dirname(conflict.path)
				const ext = path.posix.extname(conflict.path)
				const stem = `${path.posix.basename(conflict.path, ext)}.old`
				// `<stem>.old<ext>` or `<stem>.old.<N><ext>`.
				const aside = (name: string) =>
					name.startsWith(stem) && name.endsWith(ext) && /^(\.\d+)?$/.test(name.slice(stem.length, name.length - ext.length))
				const copy = await waitFor("this device's copy kept aside", SETUP_TIMEOUT_MS, () =>
					readdirSync(path.join(rootOf(conflict.pair), ...dir.split("/"))).find(aside)
				)

				keptCopy = dir === "." ? copy : `${dir}/${copy}`

				// The toast names the copy (plan C6).
				if (keptAsFromToast(toast) !== copy) {
					fail(`the toast "${toast}" does not name this device's copy ${copy}`)
				}

				const kept = keptCopy
				const sides = async (): Promise<string[]> => {
					const local = await snapshotOf(conflict.pair)
					const remote = await cloudSnapshot(cloud, `${cloudDir}/${conflict.pair}`, work)
					const want: [string, string][] = [
						[conflict.path, cloudBytes],
						[kept, conflict.sha256]
					]

					return want.flatMap(([relPath, sha]) => [
						...(local.get(relPath)?.sha256 === sha ? [] : [`disk ${relPath}`]),
						...(remote?.get(relPath)?.sha256 === sha ? [] : [`cloud ${relPath}`])
					])
				}

				await waitFor(
					"both versions on disk and in the cloud",
					LIVE_TIMEOUT_MS,
					async () => ((await sides()).length === 0 ? true : null),
					15_000
				).catch(async (error: unknown) => fail(`${errorMessage(error)}; not as expected: ${(await sides()).join(", ")}`))

				return `toast "${toast}"; no conflict counted; ${conflict.path} holds the cloud's bytes and ${kept} the edit, on disk and in the cloud`
			})

			// The resolution's own transfers are the only new ones.
			const resolution =
				keptCopy === null ? [] : [`${conflict.pair}:uploaded:${String(keptCopy)}`, `${conflict.pair}:downloaded:${conflict.path}`]

			await findings.check(
				keptCopy === null
					? "steady state: the third launch transfers nothing; the conflicts still held"
					: "steady state: after the resolution nothing else transfers and no conflict is held",
				() =>
					chain.quietActivity(
						pairIds,
						new Set([...conflictActivity, ...resolution, ...fills.map(emptyFillActivity)]),
						keptCopy === null ? conflictCounts : {}
					)
			)

			await liveEditUploads(chain, {
				name: "L14 a live edit uploads",
				file: `live-${randomBytes(4).toString("hex")}.txt`,
				localRoot: rootOf("e2e-twoway"),
				cloudDir: `${cloudDir}/e2e-twoway`,
				findings
			})

			witness = await chain.beforeSignOut()
			stageAtSignOut = marker()?.stage

			await findings.must("L15 sign out through the account menu", async () => {
				const result = await signOut(page(), findings, credentials.email, artifacts, chain.name)

				chain.signedIn = false

				return result
			})
		})

		await findings.check("L15 the sign-out wiped the session, the user's data and the PIN, and unmounted the drive", async () => {
			await waitFor("session.vault to be removed", SETUP_TIMEOUT_MS, () => (existsSync(userData("session.vault")) ? null : true))
			await waitFor("the drive to unmount", SETUP_TIMEOUT_MS, async () =>
				(await chain.os.driveMounted(drive.root)) === null ? true : null
			)

			// A sign-out ends an import not finished yet (src/main/migration.ts signedOut); a finished one stays as it was.
			const stage = marker()?.stage
			const expected = stageAtSignOut === "started" ? ["imported", "abandoned"] : [stageAtSignOut]

			if (!expected.includes(stage)) {
				fail(`migration stage ${String(stage)} after the sign-out, ${String(stageAtSignOut)} before`)
			}

			return `session.vault gone; nothing mounted; migration ${String(stage)}; ${await chain.signOutWiped(signedOutWith())}`
		})
		findings.info(
			"secret store items of Filen after the sign-out",
			(await chain.os.secretStoreItems(target.userData)).join("; ") || "none"
		)
		findings.attach("legacy-userdata-after-sign-out.txt", inventory(target.userData))

		const kept = new Map<string, Snapshot>()

		for (const pair of LEGACY_PAIRS) {
			kept.set(pair.name, await snapshotOf(pair.name))
		}

		await findings.must("N quits", async () => {
			await quitN("N")

			return "quit"
		})
		await findings.check("L15 the next launch deletes the browser profile before ready", () => chain.profileWipedOnLaunch())
		await findings.must("N quits after the profile wipe", async () => {
			await quitN("N-profile-wiped")

			return "quit"
		})
		await findings.check("L15 old profile entries are gone and none holds a value from before the sign-out", () =>
			chain.profileHoldsNoOldValue(signedOutWith(), [LEGACY_ORIGIN])
		)

		await findings.check("L15 the app uninstalled as a user does, the user's directories left", async () => {
			const removed = await chain.os.uninstall(target)

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

			return `${removed}; every pair directory intact`
		})
		findings.attach("legacy-userdata-after-uninstall.txt", inventory(path.dirname(target.userData)))
		await findings.check("L15 after the uninstall nothing of Filen's beside userData", () =>
			leftoversBeside(target.userData, release.besideUserData)
		)
	}

	// The old app's page and inspector, if a setup step failed while it ran (the harness never leaves it running).
	const setUpOrClose = async (): Promise<void> => {
		try {
			await setUp()
		} finally {
			// The old app's own logs (its logger writes beside userData, not in it); N deletes them once it verified.
			for (const name of ["desktop.log", "desktop-worker.log"]) {
				findings.attach(`legacy-3x-${name}`, tail(path.join(legacyLogs, name), 1500))
			}

			if (state.legacy !== undefined) {
				await state.legacy.renderer.browser.close().catch(() => undefined)
				await quitLegacy(state.legacy.launched, EXIT_TIMEOUT_MS, release.quit).catch(() => undefined)
			}
		}
	}

	await chain.run(options, { beforeUpdate: setUpOrClose, afterUpdate: verify, updateLaunch })
}
