import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type {
	DesktopSyncHeldDeletions,
	DesktopSyncPair,
	DesktopSyncPlan,
	DesktopSyncPlanSummary,
	DesktopSyncResolvedConflicts,
	DesktopSyncResult
} from "@filen/shared/desktop"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { desktop, desktopCall, underReminder } from "../app.ts"
import { seededBytes, type Tree, treeSnapshot } from "../fixtures.ts"
import { cloudSnapshot, diffSnapshots, localSnapshot, type Snapshot } from "../snapshot.ts"
import {
	approveHeldThroughIssues,
	binPathFromToast,
	resolveAllThroughIssues,
	resolveThroughIssues,
	syncCount,
	syncText
} from "../syncUi.ts"
import { BIN_DIR, json, LIVE_TIMEOUT_MS, ok, SETUP_TIMEOUT_MS, type Chain } from "./common.ts"

// P12: conflicts and held deletions through the Issues tab, on N, in the two-way pair (plan D2, proving C3 and C5).
//   seed        gap4/ (two keep files, three bulk files, thirty held files) is part of the pair's tree on N-1, so it
//               uploads during convergence and both sides track it
//   hold        the cloud's gap4/held purged while the pair runs: more deletions than the engine's guard lets through
//               (max(10, 0.5 x tracked) per pass; ~50 tracked), so the pass holds them (exceededThreshold). The Issues
//               tab lists held deletions from the last pass, and a paused pair runs none: the hold comes first
//   edits       then the pair paused, the keep and bulk files edited on disk and in the cloud; a dry run (sync.plan) is
//               the barrier: five conflicts and the held deletions, exceededThreshold
//   approve     while paused: the page says the approval applies on resume, Approve off (C5)
//   resume      the resumed pass applies the approved batch (the held files go to the pair's bin) and holds the five
//               conflicts
//   resolve     keep-local with Keep this device's, keep-cloud with Keep the cloud's (the toast names the bin path), the
//               three bulk files with Keep both for all (C3)
//   end state   disk, cloud and bin byte for byte (the bin's day bucket within a day of now), every issue count 0, and
//               the pair's activity since P12 began holding only what these steps make
// Restore (Keep them, plan A6/C1) is not built yet; its step goes where the TODO below says.

export const GAP4_DIR = "gap4"
const KEEP_LOCAL = `${GAP4_DIR}/keep-local.txt`
const KEEP_CLOUD = `${GAP4_DIR}/keep-cloud.txt`
const BULK = [1, 2, 3].map(index => `${GAP4_DIR}/bulk-${String(index)}.txt`)
const HELD_DIR = `${GAP4_DIR}/held`
export const HELD = Array.from({ length: 30 }, (_, index) => `${HELD_DIR}/h${String(index + 1).padStart(2, "0")}.txt`)
const CONFLICTS = [KEEP_LOCAL, KEEP_CLOUD, ...BULK]

const HOLD_TIMEOUT_MS = 3 * 60 * 1000
const BARRIER_TIMEOUT_MS = 3 * 60 * 1000
const RESUME_TIMEOUT_MS = 3 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function seedBytes(relPath: string): Buffer {
	return seededBytes(`gap4/seed/${relPath}`, 700)
}

// The edits while paused: each side's bytes differ from the seed and from each other (different sizes too).
export function localEdit(relPath: string): Buffer {
	return seededBytes(`gap4/local/${relPath}`, 1100)
}

export function cloudEdit(relPath: string): Buffer {
	return seededBytes(`gap4/cloud/${relPath}`, 1300)
}

// Adds gap4/ to the pair's tree before N-1 writes it.
export function seedConflictsCheck(tree: Tree): void {
	for (const relPath of [...CONFLICTS, ...HELD]) {
		tree.files.set(relPath, seedBytes(relPath))
	}
}

// Keep both's copy of this device's version: `<stem>.old<ext>` (sdk-rs ConflictResolution::KeepBoth), no collision here.
export function keptAside(relPath: string): string {
	const ext = path.posix.extname(relPath)

	return `${relPath.slice(0, relPath.length - ext.length)}.old${ext}`
}

// What both sides hold under gap4/ at the end: keep-local this device's edit, keep-cloud the cloud's, each bulk file the
// cloud's beside this device's as its copy; gap4/held gone.
export function expectedSides(): Snapshot {
	const files = new Map<string, Buffer>([
		[KEEP_LOCAL, localEdit(KEEP_LOCAL)],
		[KEEP_CLOUD, cloudEdit(KEEP_CLOUD)],
		...BULK.flatMap((relPath): [string, Buffer][] => [
			[relPath, cloudEdit(relPath)],
			[keptAside(relPath), localEdit(relPath)]
		])
	])

	return treeSnapshot({ files, emptyDirs: [] })
}

// The UTC day buckets (YYYY-MM-DD) within a day of `now`: a pass or a resolution near midnight files into either.
export function binDays(now: number): string[] {
	return [now - DAY_MS, now, now + DAY_MS].map(at => new Date(at).toISOString().slice(0, 10))
}

// A bin path (absolute, either separator) as its day bucket and the path below it; null when it is not in a bin.
export function binPathParts(binPath: string): { day: string; relPath: string } | null {
	const parts = binPath.split(/[\\/]+/)
	const at = parts.lastIndexOf(BIN_DIR)
	const day = parts[at + 1]

	return at < 0 || day === undefined || parts.length < at + 3 ? null : { day, relPath: parts.slice(at + 2).join("/") }
}

// What the bin holds under gap4/ at the end: this device's keep-cloud edit in its day's bucket (`keepCloudDay`) and the
// thirty held files with their seed bytes in the bucket of the pass that applied them (`heldDay`).
export function expectedBin(keepCloudDay: string, heldDay: string): Snapshot {
	const bin: Snapshot = new Map()
	const add = (day: string, files: Map<string, Buffer>) => {
		for (const [relPath, node] of treeSnapshot({ files, emptyDirs: [] })) {
			bin.set(`${day}/${relPath}`, node)
		}
	}

	add(keepCloudDay, new Map([[KEEP_CLOUD, localEdit(KEEP_CLOUD)]]))
	add(heldDay, new Map(HELD.map(relPath => [relPath, seedBytes(relPath)])))

	return bin
}

// A snapshot's entries at `prefix` and below it; with `day`, below any day bucket's `prefix`.
export function under(snapshot: Snapshot, prefix: string, day = false): Snapshot {
	const pattern = new RegExp(`^${day ? "\\d{4}-\\d{2}-\\d{2}/" : ""}${prefix}(/|$)`)

	return new Map([...snapshot].filter(([relPath]) => pattern.test(relPath)))
}

// What P12 lets the pair's activity hold (TRANSFER_KINDS only): the five conflicts, the hold, the held files binned
// (a directory or file at a time), each resolution's transfers (keep-local up, keep-cloud down, each bulk file down
// with its copy up).
export function conflictsAllowed(pair: string): Set<string> {
	return new Set([
		`${pair}:deletionsHeld:`,
		...CONFLICTS.map(relPath => `${pair}:conflict:${relPath}`),
		...[HELD_DIR, ...HELD].flatMap(relPath => [`${pair}:deletedLocal:${relPath}`, `${pair}:binned:${relPath}`]),
		`${pair}:uploaded:${KEEP_LOCAL}`,
		`${pair}:downloaded:${KEEP_CLOUD}`,
		`${pair}:binned:${KEEP_CLOUD}`,
		...BULK.flatMap(relPath => [`${pair}:downloaded:${relPath}`, `${pair}:uploaded:${keptAside(relPath)}`])
	])
}

export interface ConflictsCheckOptions {
	pairs: readonly { name: string; id: string; localRoot: string }[]
	// The pair the check runs in (two-way), and its cloud directory.
	pair: string
	cloudDir: string
}

export async function runConflictsCheck(chain: Chain, options: ConflictsCheckOptions): Promise<void> {
	const { findings, cloud, page, work } = chain
	const pair = options.pairs.find(candidate => candidate.name === options.pair) ?? fail(`no pair ${options.pair}`)
	const since = Date.now()
	const read = async (): Promise<DesktopSyncPair> =>
		(await chain.syncOverview()).pairs.find(candidate => candidate.id === pair.id) ?? fail(`${pair.name} is gone`)
	const planSummary = async (): Promise<DesktopSyncPlanSummary | null> => {
		const plan = ok(
			"plan",
			await desktop<DesktopSyncResult<DesktopSyncPlan | null>>(page(), `window.desktop.sync.plan(${json(pair.id)})`)
		)

		if (plan === null) {
			return null
		}

		await desktopCall(page(), `window.desktop.sync.releasePlan(${json(plan.planId)})`)

		return plan.summary
	}
	const local = (relPath: string) => path.join(pair.localRoot, ...relPath.split("/"))
	const putOff: number[] = []
	const ui = async <T>(run: () => Promise<T>): Promise<T> => {
		const done = await underReminder(page(), run)

		putOff.push(done.putOff)

		return done.value
	}

	try {
		const held = await findings.check(
			"P12 a pass holds the deletions of the purged gap4/held (over the guard); paused, both sides edited, a dry run shows five conflicts and the hold",
			async () => {
				await cloud.purge(`${options.cloudDir}/${HELD_DIR}`)

				const holding = await waitFor(
					"the pass to hold the deletions",
					HOLD_TIMEOUT_MS,
					async () => {
						const current = await read()

						return current.phase === "idle" && current.issues.heldDeletions >= HELD.length ? current : null
					},
					5000
				)

				ok("pausePair", await desktop<DesktopSyncResult<null>>(page(), `window.desktop.sync.pausePair(${json(pair.id)})`))

				for (const relPath of [KEEP_LOCAL, KEEP_CLOUD, ...BULK]) {
					writeFileSync(local(relPath), localEdit(relPath))
				}

				const edits = path.join(work, "gap4-cloud-edits")

				mkdirSync(edits, { recursive: true })
				await Promise.all(
					[KEEP_LOCAL, KEEP_CLOUD, ...BULK].map(async relPath => {
						const file = path.join(edits, path.posix.basename(relPath))

						writeFileSync(file, cloudEdit(relPath))
						await cloud.uploadFile(file, `${options.cloudDir}/${relPath}`)
					})
				)

				const summary = await waitFor(
					"a dry run with the five conflicts and the held deletions",
					BARRIER_TIMEOUT_MS,
					async () => {
						const current = await planSummary()

						return current !== null &&
							current.conflicts === CONFLICTS.length &&
							current.heldDeletions >= HELD.length &&
							current.heldReason === "exceededThreshold"
							? current
							: null
					},
					10_000
				)
				const paused = await read()

				if (!paused.paused || paused.issues.heldDeletions < HELD.length) {
					fail(`after the pause: paused ${String(paused.paused)}, issues ${json(paused.issues)}`)
				}

				return `${String(holding.issues.heldDeletions)} held by the pass; paused; dry run ${json(summary)}`
			}
		)

		if (!held) {
			return
		}

		const approved = await findings.check("P12 approving the held deletions while paused says it applies on resume (C5)", async () => {
			const shown = await ui(() => approveHeldThroughIssues(page(), pair.name, true, SETUP_TIMEOUT_MS))

			if (!existsSync(local(HELD_DIR))) {
				fail(`${HELD_DIR} went from the disk while paused`)
			}

			return `${shown}; nothing deleted while paused`
		})

		await findings.check("P12 the resumed pass applies the approved batch and holds the five conflicts", async () => {
			// Without the page's approval, the contract's, so the steps after this one still run; this check then fails.
			if (!approved) {
				const list = ok(
					"heldDeletions",
					await desktop<DesktopSyncResult<DesktopSyncHeldDeletions>>(
						page(),
						`window.desktop.sync.heldDeletions(${json(pair.id)})`
					)
				)

				ok(
					"approveDeletions",
					await desktop<DesktopSyncResult<null>>(
						page(),
						`window.desktop.sync.approveDeletions(${json(pair.id)}, ${json(list.passToken ?? fail("no pass token"))})`
					)
				)
			}

			ok("resumePair", await desktop<DesktopSyncResult<null>>(page(), `window.desktop.sync.resumePair(${json(pair.id)})`))

			const resumed = await waitFor(
				"the batch applied and the conflicts held",
				RESUME_TIMEOUT_MS,
				async () => {
					const current = await read()

					return !current.paused &&
						current.issues.conflicts === CONFLICTS.length &&
						current.issues.heldDeletions === 0 &&
						!existsSync(local(HELD_DIR))
						? current
						: null
				},
				5000
			).catch(async (error: unknown) => fail(`${errorMessage(error)}: ${json((await read()).issues)}`))

			if (!approved) {
				fail(`applied, but with the contract's approval (the page's failed); issues ${json(resumed.issues)}`)
			}

			return `${HELD_DIR} gone from the disk; issues ${json(resumed.issues)}`
		})

		let keepCloudBin: { day: string; relPath: string } | null = null

		await findings.check(`P12 ${KEEP_LOCAL} resolved with ${syncText("conflictKeepLocal")}`, async () => {
			const toast = await ui(() => resolveThroughIssues(page(), pair.name, KEEP_LOCAL, "keepLocal", SETUP_TIMEOUT_MS))

			if (toast !== syncText("conflictKeptLocal")) {
				fail(`toast "${toast}"`)
			}

			return `toast "${toast}"`
		})

		await findings.check(
			`P12 ${KEEP_CLOUD} resolved with ${syncText("conflictKeepRemote")}; the toast names the bin path`,
			async () => {
				const toast = await ui(() => resolveThroughIssues(page(), pair.name, KEEP_CLOUD, "keepRemote", SETUP_TIMEOUT_MS))
				const binPath = binPathFromToast(toast) ?? fail(`toast "${toast}" names no bin path`)
				const parts = binPathParts(binPath)

				if (parts === null || parts.relPath !== KEEP_CLOUD || !binDays(Date.now()).includes(parts.day)) {
					fail(`the toast's bin path ${binPath} is not ${BIN_DIR}/<a day within one of today>/${KEEP_CLOUD}`)
				}

				keepCloudBin = parts

				return `toast "${toast}"`
			}
		)

		await findings.check(`P12 the three bulk conflicts resolved with ${syncText("conflictsKeepAllBoth")} (C3)`, async () => {
			const toast = await ui(() => resolveAllThroughIssues(page(), pair.name, "keepBoth", BULK.length, SETUP_TIMEOUT_MS))
			const want = syncCount("conflictsKeptAllBoth", BULK.length)

			if (toast !== want) {
				fail(`toast "${toast}", expected "${want}"`)
			}

			return `toast "${toast}"`
		})

		// TODO(restore, plan A6 + C1): once sdk-rs restore_deletions and the Issues tab's "Keep them" button land, hold a
		// second batch here (purge again, over the guard), restore it through the page and assert both sides hold it again.

		await findings.check("P12 disk, cloud and bin byte for byte; no issue left; only these steps in the activity", async () => {
			const want = expectedSides()
			const sides = async (): Promise<string[]> => {
				const remote = await cloudSnapshot(cloud, options.cloudDir, work)

				return [
					...diffSnapshots(want, under(await chain.snapshotOf(pair.name), GAP4_DIR), { identity: false }).map(
						line => `disk ${line}`
					),
					...(remote === null
						? [`cloud ${options.cloudDir} is gone`]
						: diffSnapshots(want, under(remote, GAP4_DIR), { identity: false }).map(line => `cloud ${line}`))
				]
			}

			await waitFor(
				"both sides as resolved",
				LIVE_TIMEOUT_MS,
				async () => ((await sides()).length === 0 ? true : null),
				15_000
			).catch(async (error: unknown) => fail(`${errorMessage(error)}; ${(await sides()).join("; ")}`))

			const bin = under(await localSnapshot(path.join(pair.localRoot, BIN_DIR)), GAP4_DIR, true)
			const days = binDays(Date.now())
			const heldDay = [...bin.keys()].find(relPath => relPath.endsWith(`/${HELD_DIR}`))?.split("/")[0]
			const cloudCopy: { day: string } | null = keepCloudBin

			if (heldDay === undefined || !days.includes(heldDay) || cloudCopy === null) {
				fail(
					`the bin holds ${HELD_DIR} in ${heldDay ?? "no bucket"} (want one of ${days.join(", ")}); keep-cloud's bin path ${json(cloudCopy)}`
				)
			}

			const binned = diffSnapshots(expectedBin(cloudCopy.day, heldDay), bin, { identity: false })

			if (binned.length > 0) {
				fail(`bin: ${binned.join("; ")}`)
			}

			const issues = await waitFor("every issue count at 0", SETUP_TIMEOUT_MS, async () => {
				const current = await read()

				return Object.values(current.issues).every(count => count === 0) ? current.issues : null
			})

			return `${json(issues)}; ${await chain.quietActivity([pair], conflictsAllowed(pair.name), {}, since)}`
		})
	} finally {
		findings.info(
			"P12 the master-key reminder over the Issues tab",
			putOff.some(count => count > 0) ? `put off ${String(putOff.reduce((sum, count) => sum + count, 0))} time(s)` : "not shown"
		)
		// What a failed step left is undone through the contract, so P11 meets a running pair with no conflict or hold.
		findings.info("P12 left the pair running with no conflict or held deletion", await settle(chain, pair.id).catch(errorMessage))
	}
}

// Resumes the pair, lets one pass run (a paused pair has not looked since the edits, so its counts are stale), then
// approves what it holds and resolves what conflicts (keeping this device's), and waits for both counts at 0: what P11
// reads as needs attention.
async function settle(chain: Chain, pairId: string): Promise<string> {
	const page = chain.page()
	const read = async (): Promise<DesktopSyncPair> =>
		(await chain.syncOverview()).pairs.find(candidate => candidate.id === pairId) ?? fail("the pair is gone")
	const done: string[] = []
	const resumedAt = Date.now()

	if ((await read()).paused) {
		ok("resumePair", await desktop<DesktopSyncResult<null>>(page, `window.desktop.sync.resumePair(${json(pairId)})`))
		done.push("resumed")
	}

	const passed = await waitFor(
		"a pass to finish",
		SETUP_TIMEOUT_MS,
		async () => {
			const current = await read()

			return !current.paused &&
				current.phase === "idle" &&
				(done.length === 0 || (current.lastSyncedAt !== null && current.lastSyncedAt >= resumedAt))
				? current
				: null
		},
		5000
	)

	if (passed.issues.heldDeletions > 0) {
		const list = ok(
			"heldDeletions",
			await desktop<DesktopSyncResult<DesktopSyncHeldDeletions>>(page, `window.desktop.sync.heldDeletions(${json(pairId)})`)
		)

		ok(
			"approveDeletions",
			await desktop<DesktopSyncResult<null>>(
				page,
				`window.desktop.sync.approveDeletions(${json(pairId)}, ${json(list.passToken ?? fail("no pass token"))})`
			)
		)
		done.push(`${String(list.total)} held deletion(s) approved`)
	}

	if (passed.issues.conflicts > 0) {
		ok(
			"resolveConflicts",
			await desktop<DesktopSyncResult<DesktopSyncResolvedConflicts>>(
				page,
				`window.desktop.sync.resolveConflicts(${json(pairId)}, "keepLocal", ${String(passed.issues.conflicts)})`
			)
		)
		done.push(`${String(passed.issues.conflicts)} conflict(s) resolved keeping this device's`)
	}

	const settled = await waitFor(
		"no conflict and no held deletion",
		SETUP_TIMEOUT_MS,
		async () => {
			const current = await read()

			return current.phase === "idle" && current.issues.conflicts === 0 && current.issues.heldDeletions === 0 ? current : null
		},
		5000
	).catch(async (error: unknown) => fail(`${[...done, errorMessage(error)].join("; ")}: ${json((await read()).issues)}`))

	return `${done.join("; ") || "nothing to undo"}; issues ${json(settled.issues)}`
}
