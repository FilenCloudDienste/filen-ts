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
import { LEGACY_VERSION } from "../../legacy.ts"
import { errorMessage, fail, freePort, waitFor } from "../../support.ts"
import { desktop, MASTER_KEYS_REMINDER, putOffKeysReminder, sessionStatus, signOut, unlockThroughScreen } from "../app.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import {
	LEGACY_CONFLICTS,
	LEGACY_DELTAS,
	LEGACY_EDITS,
	LEGACY_LOCAL_TRASH,
	legacyLocalTree,
	LEGACY_PAIRS,
	legacySideTree,
	type LegacyPairFixture,
	treeSnapshot,
	writeTree
} from "../fixtures.ts"
import { launchDebuggable, type Launched } from "../launch.ts"
import {
	configureLegacy,
	LEGACY_ORIGIN,
	legacyPrefs,
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
// downloading the cloud edit and holding the disk edit as a conflict (N imports none of the old sync history, so a
// two-way path changed on one side is a conflict), moving nothing else. Then the user signs out and uninstalls.
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
//                                 trash was off; conflicts only as LEGACY_CONFLICTS; no import note, no mount notice, no
//                                 dialog over the page but the master-key reminder (put off)
//   L10  only the edits           disk and cloud over N's first passes: identities unchanged except the expected deltas
//                                 (LEGACY_DELTAS); exactly LEGACY_CONFLICTS held; N's activity and plans carry nothing else
//   L12  the bins                 each pair's bin holds exactly 3.x's local trash (moved there, content intact) and what
//                                 the cloud edit replaced, under the day's bucket; neither ever in the cloud
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
	purged?: boolean
}

interface ShellState {
	pairs?: { name: string; pairId: string | null; state: string; review: unknown }[]
}

export async function runLegacyDeep(options: Omit<UpdateOptions, "hooks">, artifacts: string): Promise<void> {
	if (options.target.platform !== "linux" || options.target.format !== "deb") {
		fail("the deep 3.0.53 -> N chain runs on Linux deb only so far")
	}

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
		// What each pair's old local trash directory held as 3.x left it (null where it had none).
		trash?: Map<string, Snapshot | null>
		// The prefs 3.x's options.v1.json held (the rest are in its localStorage only).
		mirrored?: string[]
		afterCloud?: Snapshot
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
								...diffSnapshots(treeSnapshot(legacyLocalTree(pair)), await snapshotOf(pair.name), {
									identity: false
								}).map(line => `${pair.name} local: ${line}`)
							)

							const remoteSide = await cloudSnapshot(cloud, `${cloudDir}/${pair.name}`, work)

							differences.push(
								...(remoteSide === null
									? [`${pair.name} cloud: no directory`]
									: diffSnapshots(treeSnapshot(legacySideTree(pair, "cloud")), remoteSide, { identity: false }).map(
											line => `${pair.name} cloud: ${line}`
										))
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

		// The prefs live in the page's localStorage; options.v1.json is main's mirror, which 3.0.53 writes from two
		// concurrent read-merge-write calls (setMinimizeToTray, setStartMinimized), so it may keep only one key. 4.x takes
		// minimizeToTray from localStorage first and startMinimized from the file first, each filled in from the other
		// (legacyPrefs); L4 checks the outcome.
		await findings.must(
			`${LEGACY_VERSION} keeps the prefs on (localStorage; its options.v1.json mirror never says otherwise)`,
			async () => {
				const stored = await legacyPrefs(legacyPage())
				const options = readJson(userData("options.v1.json")) as Record<string, unknown> | null
				const mirrored = (["minimizeToTray", "startMinimized"] as const).filter(key => options?.[key] !== undefined)

				if (!stored.minimizeToTray || !stored.startMinimized || mirrored.some(key => options?.[key] !== true)) {
					fail(`localStorage ${json(stored)}; options.v1.json ${json(options)}`)
				}

				state.mirrored = mirrored

				return `localStorage both on; options.v1.json mirrors ${mirrored.join(", ") || "neither"}`
			}
		)

		await findings.must(`${LEGACY_VERSION} quits through app.quit(), rclone with it`, async () => {
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

			if (delta.change === "binned") {
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

		await findings.check(
			"L10 N's first passes carry the cloud edit, hold the disk edit, move nothing else (disk and cloud)",
			async () => {
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
					const allowed = LEGACY_DELTAS.filter(delta => delta.pair === pair.name && delta.side === "local").map(
						delta => delta.path
					)
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

				return `${json(prefs)}; 3.x's options.v1.json held ${(state.mirrored ?? []).join(", ") || "neither"}`
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
								...(json(found.issues) ===
								json({
									...found.issues,
									conflicts: expectedConflicts(fixture.name),
									heldDeletions: 0,
									unsyncable: 0,
									failed: 0
								})
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
				)
			])

			await findings.check("L10 N's activity and plans carry nothing but the edits and the expected conflicts", () =>
				chain.quietActivity(pairIds, allowed, conflictCounts)
			)

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

			await findings.check("steady state: the third launch transfers nothing; the conflicts still held", () =>
				chain.quietActivity(pairIds, new Set(conflictActivity), conflictCounts)
			)

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
			// The old app's own logs (its logger writes beside userData, not in it).
			for (const name of ["desktop.log", "desktop-worker.log"]) {
				findings.attach(`legacy-3x-${name}`, tail(path.join(path.dirname(target.userData), "logs", name), 1500))
			}

			if (state.legacy !== undefined) {
				await state.legacy.renderer.browser.close().catch(() => undefined)
				await quitLegacy(state.legacy.launched, EXIT_TIMEOUT_MS).catch(() => undefined)
			}
		}
	}

	await chain.run(options, { beforeUpdate: setUpOrClose, afterUpdate: verify, updateLaunch })
}
