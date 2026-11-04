import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopSyncEntries, DesktopSyncMode, DesktopSyncPair, DesktopSyncResult, DesktopSyncUnsyncable } from "@filen/shared/desktop"
import { errorMessage, fail, runBounded } from "../../support.ts"
import { desktop } from "../app.ts"
import type { CloudEntry } from "../cloud.ts"
import {
	expectedCloudReasons,
	expectedUnsyncable,
	type NameFixture,
	type NameOs,
	nameBytes,
	NAMES_OUTSIDE_FILE,
	NAMES_PAIR,
	NAMES_RENAMES,
	namesFor,
	outsideBytes,
	treeSnapshot
} from "../fixtures.ts"
import { addPairThroughChooser, pairOf, removePair as removeExtraPair, sha256, syncNow } from "../extraPair.ts"
import { currentScale, scaleLayout, scaleTree, SCALE_UNSEEDED } from "../scaleTree.ts"
import { diffSnapshots, localSnapshot, type Snapshot, underAny } from "../snapshot.ts"
import { BIN_DIR, json, LIVE_TIMEOUT_MS, ok, quiet, type Chain } from "./common.ts"

// Chain P's real-world pairs (plan gap 6), on linux-x64-deb, win-x64-nsis and mac-arm64-dmg only, added on N-1 once the
// chain's own three pairs converged and removed on N before P11, so the chain's other checks see its three pairs alone.
//
//   PS  the permanent scale tree (scaleTree.ts, about 8,500 entries) pulled by a remoteToLocal pair, e2e-scale; on by
//       default; off with a warning until the tree is first seeded. Its integrity against the manifest is checked once
//       a run by the session job and the sweep. A pull that fails PS1 or PS2 has its pair removed at once, so the update
//       and P4 run with the chain's own pairs and a scale problem fails by its own name only.
//   PN  the names pair, e2e-names (twoWay): hostile and unusual names on both sides (fixtures.ts NAME_FIXTURES) with
//       per-OS outcomes, then renames and an edit on N. The outcomes are those of sdk-rs's names fix (0.5.19): on
//       unless E2E_NAMES_CHECK=0 (dispatch input names_check).
//
// The assertion table (each one a finding):
//   PS0 the manifest names the tree's current generation (none: the pair is off, with a note)
//   PS1 the pull goes idle within 8 min (the time is information)
//   PS2 the local tree is the generated tree byte for byte
//   PS3 (P4) N's first launch rewrites nothing of it (identities unchanged across the update)
//   PS4 how long one local edit takes to advance the pair's lastSyncedAt (information, 2 min bound)
//   PN0 both sides seeded; rclone kept every cloud name exactly (else an infra failure)
//   PN1 the first pass and two more on request (syncNow) complete
//   PN2 the pair reports exactly this OS's unsyncable set, the cloud-seeded names as ones this device can't store
//   PN3 every cloud-seeded item keeps its uuid and exact name; the ones this OS can hold are on disk with their bytes
//   PN4 every device-seeded item that syncs is in the cloud once, with its bytes (sha256Of); the rest are not; NFD names
//       keep their spelling on disk with no NFC sibling
//   PN5 on N: a case rename on each side and an edit of the cloud's NFD file each leave exactly one cloud item; each
//       renamed one keeps the uuid it had before (a rename, not a deletion and a new upload)

const ENTRIES = new Set(["linux-x64-deb", "win-x64-nsis", "mac-arm64-dmg"])
const SCALE_PAIR = "e2e-scale"
const SCALE_IDLE_MS = 8 * 60 * 1000
const NAMES_FIRST_PASS_MS = 8 * 60 * 1000
const EDIT_BOUND_MS = 2 * 60 * 1000
const RENAMES_MS = 3 * 60 * 1000
// Where a directory link leads outside the root, below the chain's work directory.
const OUTSIDE = "@out/"

export interface RealWorld {
	// On N-1, signed in, after the chain's own pairs converged and before its baseline.
	setUp(): Promise<void>
	// Right after P4's quiet on N's first launch (no debugging port).
	afterUpdate(): Promise<void>
	// On N, unlocked, before P11: the timings and the renames, then both pairs removed.
	onN(): Promise<void>
	// Cloud paths below the chain's directory that belong to these pairs, for its own snapshots to leave out.
	readonly cloudExclude: readonly string[]
}

interface Added {
	name: string
	id: string
	localRoot: string
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`
}

const nfc = (relPath: string) => relPath.normalize("NFC")
const folded = (relPath: string) => nfc(relPath).toLowerCase()

// PN5's case renames as they stand (`listed`: the cloud's files, `local`: the paths on disk, `ids`: each renamed file's
// cloud uuid before the rename): what does not hold yet. Each is exactly one cloud item, spelled as renamed, with the
// uuid it had (a rename, not a deletion and a new upload); the cloud's rename is on disk once, as spelled.
export function renameProblems(
	listed: readonly CloudEntry[],
	local: Iterable<string>,
	ids: Readonly<Record<"local" | "cloud", string>>
): string[] {
	const localPaths = [...local]
	const problems: string[] = []

	for (const side of ["local", "cloud"] as const) {
		const spelled = NAMES_RENAMES[side].to
		const found = listed.filter(item => folded(item.path) === folded(spelled))

		if (found.length !== 1 || found[0]?.path !== spelled) {
			problems.push(`cloud ${json(found.map(item => item.path))}, expected [${json(spelled)}]`)
		} else if (found[0].id !== ids[side]) {
			problems.push(`${json(spelled)} has uuid ${found[0].id}, not ${ids[side]}: deleted and uploaded anew, not renamed`)
		}
	}

	const onDisk = localPaths.filter(relPath => folded(relPath) === folded(NAMES_RENAMES.cloud.to))

	if (onDisk.length !== 1 || onDisk[0] !== NAMES_RENAMES.cloud.to) {
		problems.push(`on disk ${json(onDisk)}, expected [${json(NAMES_RENAMES.cloud.to)}]`)
	}

	return problems
}

export function realWorldFor(chain: Chain, arch: string): RealWorld {
	const { findings, cloud, target } = chain
	const entry = `${target.platform}-${arch}-${target.format}`
	const scaleOn = ENTRIES.has(entry)
	const namesOn = ENTRIES.has(entry) && process.env["E2E_NAMES_CHECK"] !== "0"
	const os: NameOs = target.platform
	const cloudNames = `${chain.cloudDir}/${NAMES_PAIR}`
	const state: {
		scale?: Added
		scaleBaseline?: Snapshot
		names?: Added
		// The cloud-seeded items' uuids, by exact path.
		seededIds?: Map<string, string>
		// Fixtures this runner could not seed (a file symlink without the privilege), left out of every expectation.
		unseeded?: Set<string>
	} = {}

	const overviewOf = async (pair: Added): Promise<DesktopSyncPair> => pairOf(chain, pair.id)

	// Until the pair is idle after a pass completed later than `after`, at most `timeoutMs`; null when it was not.
	const settled = async (pair: Added, after: number, timeoutMs: number): Promise<DesktopSyncPair | null> => {
		const deadline = Date.now() + timeoutMs

		for (;;) {
			const found = await overviewOf(pair)

			if (found.phase === "idle" && found.lastSyncedAt !== null && found.lastSyncedAt > after && found.review === null) {
				return found
			}

			if (Date.now() >= deadline) {
				return null
			}

			await new Promise(resolve => setTimeout(resolve, 3000))
		}
	}

	const describePair = (found: DesktopSyncPair) =>
		json({
			phase: found.phase,
			lastSyncedAt: found.lastSyncedAt,
			lastError: found.lastError,
			issues: found.issues,
			review: found.review
		})

	// The pair added through the native folder chooser, as a user adds one, and started after its dry run; `record`
	// learns of it as soon as it exists, so that a failed start still leaves it for removal.
	const addPair = async (name: string, mode: DesktopSyncMode, remoteRoot: string, record: (pair: Added) => void): Promise<Added> => {
		mkdirSync(chain.rootOf(name), { recursive: true })

		return addPairThroughChooser(chain, { name, mode, localRoot: chain.rootOf(name), remoteRoot }, record)
	}

	const removePair = async (pair: Added): Promise<void> => {
		await removeExtraPair(chain, pair.id)
	}

	const scaleSetUp = async (): Promise<void> => {
		// The generation the manifest names now: a reseed in another run writes a new one and keeps this one.
		const read: { dir?: string | null } = {}

		await findings.check("PS0 the scale tree's manifest names its current generation", async () => {
			read.dir = (await currentScale(cloud))?.dir ?? null

			return read.dir ?? "none yet"
		})

		const dir = read.dir

		if (dir === null) {
			findings.info("PS scale pair", `off: ${SCALE_UNSEEDED}`)

			return
		}

		if (dir === undefined) {
			return
		}

		const pulled = await findings.check(
			`PS1 ${SCALE_PAIR} (remoteToLocal) pulls the permanent tree and goes idle within 8 min`,
			async () => {
				const pair = await addPair(SCALE_PAIR, "remoteToLocal", await cloud.dirId(dir), added => {
					state.scale = added
				})
				const started = Date.now()
				const idle = await settled(pair, 0, SCALE_IDLE_MS)

				if (idle === null) {
					fail(`not idle within 8 min: ${describePair(await overviewOf(pair))}`)
				}

				findings.info("PS1 the scale pull's time to idle on N-1", seconds(Date.now() - started))

				return `idle after ${seconds(Date.now() - started)}`
			}
		)

		if (pulled) {
			await findings.check("PS2 the pulled tree is the generated tree byte for byte", async () => {
				const local = await chain.snapshotOf(SCALE_PAIR)
				const differences = diffSnapshots(treeSnapshot(scaleTree()), local, { identity: false })

				if (differences.length > 0) {
					fail(`${String(differences.length)} differences: ${differences.slice(0, 10).join("; ")}`)
				}

				state.scaleBaseline = local

				return `${String(local.size)} entries`
			})
		}

		const failed = state.scale

		if (state.scaleBaseline !== undefined || failed === undefined) {
			return
		}

		delete state.scale
		await findings.check("the scale pair removed at once after PS1 or PS2 failed (the update runs without it)", async () => {
			await removePair(failed)

			return failed.name
		})
	}

	// Writes the local half of the names pair; returns what it could not create.
	const seedLocalNames = async (root: string): Promise<string[]> => {
		const outside = path.join(chain.work, "names-outside")
		const unseeded: string[] = []

		mkdirSync(path.join(outside, "outside"), { recursive: true })
		writeFileSync(path.join(outside, "outside", NAMES_OUTSIDE_FILE), outsideBytes())

		const fixtures = namesFor(os).filter(fixture => fixture.side === "local")

		// Files first: a link inside the root leads to one of them.
		for (const fixture of fixtures.filter(candidate => candidate.link === undefined)) {
			const file = path.join(root, ...fixture.path.split("/"))

			mkdirSync(path.dirname(file), { recursive: true })
			writeFileSync(file, nameBytes(fixture))

			if (fixture.hidden === true) {
				const result = await runBounded("attrib", ["+h", file], 30_000)

				if (result.status !== 0) {
					fail(`attrib +h ${fixture.path}: exit ${String(result.status)}`)
				}
			}
		}

		for (const fixture of fixtures) {
			const link = fixture.link

			if (link === undefined) {
				continue
			}

			const at = path.join(root, ...fixture.path.split("/"))
			const to = link.target.startsWith(OUTSIDE)
				? path.join(outside, link.target.slice(OUTSIDE.length))
				: path.join(root, ...link.target.split("/"))

			try {
				symlinkSync(to, at, link.dir ? (process.platform === "win32" ? "junction" : "dir") : "file")
			} catch (error) {
				// A file symlink needs a privilege on Windows that a runner may not grant; a junction never does.
				if (link.dir || process.platform !== "win32") {
					throw error
				}

				unseeded.push(fixture.path)
				findings.info(`PN0 ${fixture.path} not seeded`, errorMessage(error))
			}
		}

		return unseeded
	}

	const namesSetUp = async (): Promise<void> => {
		const root = chain.rootOf(NAMES_PAIR)

		await findings.check("PN0 the names seeded on both sides; rclone kept every cloud name exactly", async () => {
			const seed = path.join(chain.work, "names-seed")
			const cloudFixtures = namesFor(os).filter(fixture => fixture.side === "cloud")

			mkdirSync(seed, { recursive: true })
			await cloud.mkdir(cloudNames)

			for (const [index, fixture] of cloudFixtures.entries()) {
				const file = path.join(seed, `${String(index)}.bin`)

				writeFileSync(file, nameBytes(fixture))
				await cloud.uploadFile(file, `${cloudNames}/${fixture.path}`)
			}

			const listed = (await cloud.list(cloudNames)) ?? fail(`${cloudNames} is gone`)
			const ids = new Map<string, string>()
			const changed = cloudFixtures.filter(fixture => {
				const found = listed.find(candidate => !candidate.isDir && candidate.path === fixture.path)

				if (found !== undefined) {
					ids.set(fixture.path, found.id)
				}

				return found === undefined
			})

			if (changed.length > 0) {
				fail(
					`infra: rclone did not keep ${changed.map(fixture => json(fixture.path)).join(", ")}; it listed ${listed.map(item => json(item.path)).join(", ")}`
				)
			}

			state.seededIds = ids
			state.unseeded = new Set(await seedLocalNames(root))

			return `${String(cloudFixtures.length)} in the cloud, ${String(namesFor(os).length - cloudFixtures.length - state.unseeded.size)} on disk`
		})

		if (state.seededIds === undefined) {
			return
		}

		await findings.check(`PN1 ${NAMES_PAIR} (twoWay): the first pass, then two more on request (syncNow)`, async () => {
			const pair = await addPair(NAMES_PAIR, "twoWay", await cloud.dirId(cloudNames), added => {
				state.names = added
			})

			const first = await settled(pair, 0, NAMES_FIRST_PASS_MS)

			if (first === null) {
				fail(`no first pass within 8 min: ${describePair(await overviewOf(pair))}`)
			}

			let last = first

			for (const round of [1, 2]) {
				const before = last.lastSyncedAt ?? 0

				await syncNow(chain, pair.id)

				last =
					(await settled(pair, before, LIVE_TIMEOUT_MS)) ??
					fail(`syncNow ${String(round)} completed no pass within 2 min: ${describePair(await overviewOf(pair))}`)
			}

			return `three passes; issues ${json(last.issues)}`
		})

		const pair = state.names

		if (pair === undefined) {
			return
		}

		const fixtures = namesFor(os).filter(fixture => state.unseeded?.has(fixture.path) !== true)
		const reported = (fixture: NameFixture) => nfc(fixture.reportedAs ?? fixture.path)

		await findings.check(`PN2 the pair reports exactly ${os}'s unsyncable set`, async () => {
			const page = ok(
				"unsyncablePaths",
				await desktop<DesktopSyncResult<DesktopSyncEntries<DesktopSyncUnsyncable> | null>>(
					chain.page(),
					`window.desktop.sync.unsyncablePaths(${json(pair.id)}, 0, 200)`
				)
			)
			const entries = page?.entries ?? fail("no pass reported its unsyncable paths")
			const expected = expectedUnsyncable(os).filter(relPath => fixtures.some(fixture => reported(fixture) === relPath))
			const listed = entries.map(item => nfc(item.relPath))
			const missing = expected.filter(relPath => !listed.includes(relPath))
			const extra = entries.filter(item => !underAny(nfc(item.relPath), expected))
			const reasons = expectedCloudReasons(os)
			const misreported = entries.filter(item => {
				const want = reasons.get(nfc(item.relPath))

				return want !== undefined && item.reason !== want
			})
			const described = entries.map(item => `${item.relPath} (${item.reason}${item.detail === null ? "" : `: ${item.detail}`})`)

			findings.attach("previous-names-unsyncable.json", json(entries))

			if (missing.length > 0 || extra.length > 0 || misreported.length > 0) {
				fail(
					`missing ${json(missing)}; not expected ${json(extra.map(item => item.relPath))}; not reported as a name this device can't store ${json(misreported.map(item => item.relPath))}; reported: ${described.join(" | ")}`
				)
			}

			return described.join(" | ") || "none"
		})

		const localRaw = async () => localSnapshot(root, { raw: true, skip: relPath => relPath === BIN_DIR })
		// Raw paths on disk by NFC key; more than one is an NFC sibling.
		const byNfc = (snapshot: Snapshot) => {
			const keys = new Map<string, string[]>()

			for (const relPath of snapshot.keys()) {
				keys.set(nfc(relPath), [...(keys.get(nfc(relPath)) ?? []), relPath])
			}

			return keys
		}
		const absentBelow = (paths: Iterable<string>, under: string) => [...paths].filter(relPath => underAny(nfc(relPath), [under]))

		await findings.check("PN3 every cloud-seeded item keeps its uuid and exact name; the ones this OS holds are on disk", async () => {
			const listed = (await cloud.list(cloudNames)) ?? fail(`${cloudNames} is gone`)
			const local = await localRaw()
			const keys = byNfc(local)
			const problems: string[] = []

			for (const fixture of fixtures.filter(candidate => candidate.side === "cloud")) {
				const found = listed.find(candidate => !candidate.isDir && candidate.path === fixture.path)

				if (found?.id !== state.seededIds?.get(fixture.path)) {
					problems.push(`${json(fixture.path)} ${found === undefined ? "renamed or gone in the cloud" : "has another uuid"}`)
				}

				const onDisk = keys.get(nfc(fixture.path))

				if (fixture.expect === "synced") {
					const node = onDisk?.length === 1 ? local.get(onDisk[0] ?? "") : undefined

					if (node?.sha256 !== sha256(nameBytes(fixture))) {
						problems.push(
							`${json(fixture.path)} ${node === undefined ? `not on disk (${json(onDisk ?? [])})` : "on disk with other bytes"}`
						)
					}
				} else {
					const there = absentBelow(local.keys(), reported(fixture))

					if (there.length > 0) {
						problems.push(`${json(fixture.path)} (${fixture.expect}) on disk: ${json(there)}`)
					}
				}
			}

			if (problems.length > 0) {
				fail(problems.join("; "))
			}

			return "uuids and names kept; on disk where this OS holds them"
		})

		await findings.check(
			"PN4 device-seeded items that sync are in the cloud once with their bytes, the rest are not; NFD names kept on disk",
			async () => {
				const listed = (await cloud.list(cloudNames)) ?? fail(`${cloudNames} is gone`)
				const files = listed.filter(item => !item.isDir)
				const problems: string[] = []

				for (const fixture of fixtures.filter(candidate => candidate.side === "local")) {
					if (fixture.expect !== "synced") {
						const there = absentBelow(
							listed.map(item => item.path),
							reported(fixture)
						)

						if (there.length > 0) {
							problems.push(`${json(fixture.path)} (${fixture.expect}) reached the cloud: ${json(there)}`)
						}

						continue
					}

					const [relPath, bytes] =
						fixture.link?.dir === true
							? [`${fixture.path}/${NAMES_OUTSIDE_FILE}`, outsideBytes()]
							: [fixture.path, nameBytes(fixture)]
					const matches = files.filter(item => nfc(item.path) === nfc(relPath))

					if (matches.length !== 1 || matches[0] === undefined) {
						problems.push(`${json(relPath)}: ${String(matches.length)} cloud items`)
					} else if ((await cloud.sha256Of(`${cloudNames}/${matches[0].path}`)) !== sha256(bytes)) {
						problems.push(`${json(relPath)}: other bytes in the cloud`)
					}
				}

				const local = await localRaw()
				const siblings = [...byNfc(local).values()].filter(spellings => spellings.length > 1)
				const nfd = fixtures.filter(fixture => fixture.side === "local" && fixture.path !== nfc(fixture.path))
				const respelled = nfd.filter(fixture => !local.has(fixture.path))

				if (siblings.length > 0) {
					problems.push(`NFC siblings on disk: ${json(siblings)}`)
				}

				if (respelled.length > 0) {
					problems.push(`NFD names not on disk as spelled: ${json(respelled.map(fixture => fixture.path))}`)
				}

				if (problems.length > 0) {
					fail(problems.join("; "))
				}

				return `every synced item once in the cloud with its bytes; ${String(nfd.length)} NFD names kept as spelled`
			}
		)
	}

	// PN5's three outcomes as they stand: null when every one holds, else what does not.
	const renamesPending = async (root: string, ids: Readonly<Record<"local" | "cloud", string>>): Promise<string | null> => {
		const listed = ((await cloud.list(cloudNames)) ?? []).filter(item => !item.isDir)
		const local = await localSnapshot(root, { raw: true, skip: relPath => relPath === BIN_DIR })
		const problems = renameProblems(listed, local.keys(), ids)
		const { edit } = NAMES_RENAMES
		const edited: CloudEntry[] = listed.filter(item => nfc(item.path) === nfc(edit.path))

		if (edited.length !== 1 || edited[0] === undefined) {
			problems.push(`cloud ${json(edited.map(item => item.path))} for ${json(nfc(edit.path))}, expected one`)
		} else if ((await cloud.sha256Of(`${cloudNames}/${edited[0].path}`)) !== sha256(edit.bytes)) {
			problems.push(`${json(edited[0].path)} does not hold the edit yet`)
		}

		return problems.length === 0 ? null : problems.join("; ")
	}

	const namesOnN = async (pair: Added): Promise<void> => {
		const root = chain.rootOf(NAMES_PAIR)

		await findings.check(
			"PN5 a case rename on each side and an edit of the cloud's NFD file each leave exactly one cloud item, the renamed ones with their uuids",
			async () => {
				const { local: localRename, cloud: cloudRename, edit } = NAMES_RENAMES
				const local = await localSnapshot(root, { raw: true })
				const editedOnDisk =
					[...local.keys()].find(relPath => nfc(relPath) === nfc(edit.path)) ?? fail(`${json(edit.path)} is not on disk`)
				const before = (await cloud.list(cloudNames)) ?? fail(`${cloudNames} is gone`)
				const idOf = (spelled: string) =>
					before.find(item => !item.isDir && item.path === spelled)?.id ??
					fail(`${json(spelled)} is not in the cloud before its rename`)
				const ids = { local: idOf(localRename.from), cloud: idOf(cloudRename.from) }

				renameSync(path.join(root, localRename.from), path.join(root, localRename.to))
				await cloud.moveto(`${cloudNames}/${cloudRename.from}`, `${cloudNames}/${cloudRename.to}`)

				if ((await cloud.list(cloudNames, false))?.some(item => item.path === cloudRename.to) !== true) {
					fail(`infra: rclone moveto did not rename ${cloudRename.from} to ${cloudRename.to}`)
				}

				writeFileSync(path.join(root, ...editedOnDisk.split("/")), edit.bytes)
				await syncNow(chain, pair.id)

				const started = Date.now()
				let pending = await renamesPending(root, ids)

				while (pending !== null && Date.now() - started < RENAMES_MS) {
					await new Promise(resolve => setTimeout(resolve, 5000))
					pending = await renamesPending(root, ids)
				}

				if (pending !== null) {
					fail(`after 3 min: ${pending}; the pair: ${describePair(await overviewOf(pair))}`)
				}

				return `report.txt and notes.md once each, as renamed, with their uuids; the NFD file's edit in its one cloud item (${seconds(Date.now() - started)})`
			}
		)
	}

	const scaleOnN = async (pair: Added): Promise<void> => {
		const before = await overviewOf(pair)
		// The second file: the first is one of the empty ones.
		const file = scaleLayout().files[1]?.path ?? fail("the scale tree has no files")
		const edited = Date.now()

		writeFileSync(path.join(pair.localRoot, ...file.split("/")), `edited ${String(edited)}\n`)

		const advanced = await settled(pair, Math.max(edited, before.lastSyncedAt ?? 0), EDIT_BOUND_MS)

		findings.info(
			"PS4 one local edit in the scale tree to an advanced lastSyncedAt",
			advanced === null
				? `not within 2 min: ${describePair(await overviewOf(pair))}`
				: `${seconds((advanced.lastSyncedAt ?? edited) - edited)} (${file})`
		)
	}

	const removeAll = async (): Promise<void> => {
		const pairs = [state.names, state.scale].filter((pair): pair is Added => pair !== undefined)

		if (pairs.length === 0) {
			return
		}

		await findings.check("the real-world pairs removed before P11 (their files stay)", async () => {
			for (const pair of pairs) {
				await removePair(pair)
			}

			return pairs.map(pair => pair.name).join(", ")
		})
	}

	return {
		cloudExclude: namesOn ? [NAMES_PAIR] : [],

		async setUp() {
			if (scaleOn) {
				await scaleSetUp()
			}

			if (namesOn) {
				await namesSetUp()
			} else if (scaleOn) {
				findings.info("PN names pair", "off (E2E_NAMES_CHECK=0)")
			}
		},

		async afterUpdate() {
			const pair = state.scale
			const baseline = state.scaleBaseline

			if (pair === undefined || baseline === undefined) {
				return
			}

			await findings.check("PS3 (P4) N's first launch rewrites nothing of the scale tree (identities unchanged)", async () => {
				await quiet([chain.rootOf(SCALE_PAIR)])

				const differences = diffSnapshots(baseline, await chain.snapshotOf(SCALE_PAIR), { identity: true })

				if (differences.length > 0) {
					fail(`${String(differences.length)} differences: ${differences.slice(0, 10).join("; ")}`)
				}

				return `${String(baseline.size)} entries, identities unchanged`
			})
		},

		async onN() {
			try {
				if (state.scale !== undefined) {
					await scaleOnN(state.scale)
				}

				if (state.names !== undefined) {
					await namesOnN(state.names)
				}
			} finally {
				await removeAll()
			}
		}
	}
}
