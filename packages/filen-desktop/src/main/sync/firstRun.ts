import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
	DesktopSyncErrorCode,
	DesktopSyncHold,
	DesktopSyncMode,
	DesktopSyncNotice,
	DesktopSyncPlanSummary,
	DesktopSyncReview,
	DesktopSyncReviewFinding
} from "@filen/shared/desktop"
import type { NativeOpArgs, SyncOp } from "../../shared/nativeProtocol.ts"
import { errorCode } from "../atomicFile.ts"
import type { NativeResult } from "../native/rpc.ts"
import { withRules } from "./legacyPairs.ts"
import { inspectLocalRoot, type LocalRootContext, samePath } from "./localRoot.ts"
import { shellPairId } from "./mirror.ts"
import type { ShellPair, SyncStore } from "./store.ts"

// The first run of a pair the user did not just add (PLAN §6.6). A migrated pair is dry-run once its cloud directory
// is read and starts by itself unless the run would hold deletions, hit many conflicts, be refused, or (one-way) replace
// a lot on its destination; it then waits in review. Migrated pairs start one at a time, each on a guard that holds
// every deletion until a clean pass. One a baseline reset lost starts only when its dry run is close to nothing.

export interface FirstRunDeps {
	// Engine calls for the user this run is for; another user's host answers none of them.
	call<K extends SyncOp>(op: K, args: NativeOpArgs<K>): Promise<NativeResult<K>>
	store: SyncStore
	now(): number
	// Where no pair may be, without the pairs (attach adds the ones the engine holds).
	rootContext(): Promise<Omit<LocalRootContext, "pairRoots">>
	// The account's drive root directory; null when unknown.
	driveRoot: string | null
	// How many times in a row each preparing pair's cloud directory was not read in time.
	listingRounds: Map<string, number>
	// A migrated pair is about to start (its first pass may end before the start returns), or did not start after all
	// (null).
	starting(pairId: string | null): void
	log: { info(message: string): void; warn(message: string): void }
}

// The pair's bin: where the engine moves local files it replaced or deleted. The engine never syncs it.
export const BIN_DIR = ".filen-sync-trash"

export const FIRST_RUN_LIMITS = { maxBytes: 1_048_576, maxTransfers: 25 }

// A migrated one-way pair waits in review when its first run would replace more than either on its destination.
export const MAX_OVERWRITE_BYTES = 1_073_741_824
export const MAX_OVERWRITE_FILES = 1000
// A migrated pair waits in review when its first run would hold more conflicts.
export const MAX_MIGRATED_CONFLICTS = 50
// Rounds of a cloud directory not read in time before the pair says so.
export const SLOW_LISTING_ROUNDS = 5

export interface FirstRunPlan {
	summary: DesktopSyncPlanSummary
	// The plan's upload and download actions, and those that replace a file on their destination.
	uploads: number
	downloads: number
	overwrites: { files: number; bytes: number }
}

export type FirstRunVerdict = { start: true } | { start: false; findings: DesktopSyncReviewFinding[] }

// A pair a baseline reset lost. `plan` is null when the remote side had not converged, so nothing could be planned.
export function firstRunVerdict(
	plan: FirstRunPlan | null,
	limits: { maxBytes: number; maxTransfers: number } = FIRST_RUN_LIMITS
): FirstRunVerdict {
	if (plan === null) {
		return { start: false, findings: ["unconverged"] }
	}

	const findings: DesktopSyncReviewFinding[] = []
	const { summary, uploads, downloads } = plan

	if (summary.uploadBytes + summary.downloadBytes > limits.maxBytes || uploads + downloads > limits.maxTransfers) {
		if (uploads > 0 || summary.uploadBytes > 0) {
			findings.push("uploads")
		}

		if (downloads > 0 || summary.downloadBytes > 0) {
			findings.push("downloads")
		}
	}

	if (summary.conflicts > 0) {
		findings.push("conflicts")
	}

	if (summary.heldDeletions > 0) {
		findings.push("heldDeletions")
	}

	if (summary.refused !== null) {
		findings.push("refused")
	}

	return findings.length === 0 ? { start: true } : { start: false, findings }
}

// A migrated pair's verdict: ordinary transfers never hold it.
export function migratedVerdict(plan: FirstRunPlan, mode: DesktopSyncMode): FirstRunVerdict {
	const findings: DesktopSyncReviewFinding[] = []
	const { summary, overwrites } = plan

	if (summary.conflicts > MAX_MIGRATED_CONFLICTS) {
		findings.push("conflicts")
	}

	if (summary.heldDeletions > 0) {
		findings.push("heldDeletions")
	}

	if (summary.refused !== null) {
		findings.push("refused")
	}

	if (mode !== "twoWay" && (overwrites.files > MAX_OVERWRITE_FILES || overwrites.bytes > MAX_OVERWRITE_BYTES)) {
		findings.push("overwrites")
	}

	return findings.length === 0 ? { start: true } : { start: false, findings }
}

function patchPair(store: SyncStore, matches: (pair: ShellPair) => boolean, patch: Partial<ShellPair>): Promise<unknown> {
	return store.update(state => ({ ...state, pairs: state.pairs.map(pair => (matches(pair) ? { ...pair, ...patch } : pair)) }))
}

// Dry-runs a held pair and releases the plan; null when its cloud directory is not read yet or a call failed.
async function evaluate(deps: FirstRunDeps, pairId: string): Promise<FirstRunPlan | null> {
	const evaluated = await deps.call("evaluatePlan", { pairId, check: true })

	if (!evaluated.ok) {
		deps.log.warn(`sync: a pair was not planned: ${evaluated.error.code}`)

		return null
	}

	if (evaluated.value.status === "unconverged") {
		return null
	}

	const { planId, summary: native, check } = evaluated.value
	const { passToken: _passToken, ...summary } = native

	await deps.call("releasePlan", { planId })

	// A host that skipped the scan leaves every action in doubt.
	return {
		summary,
		uploads: check?.uploads ?? summary.actions,
		downloads: check?.downloads ?? summary.actions,
		overwrites: check?.overwrites ?? { files: summary.actions, bytes: summary.uploadBytes + summary.downloadBytes }
	}
}

// The pair (an engine id) is held and paused already. A failed call leaves it paused in the review it has.
export async function runFirstRun(deps: FirstRunDeps, pairId: string, options: { paused: boolean }): Promise<void> {
	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, pair => pair.pairId === pairId, fields)
	const plan = await evaluate(deps, pairId)
	const verdict = firstRunVerdict(plan)
	const summary = plan?.summary ?? null

	if (!verdict.start) {
		await patch({ paused: true, state: "review", review: { reason: "baselineReset", findings: verdict.findings, summary } })

		return
	}

	if (options.paused) {
		await patch({ state: "active", review: null })

		return
	}

	const resumed = await deps.call("resume", { pairId })

	await patch(
		resumed.ok
			? { paused: false, state: "active", review: null }
			: { paused: true, state: "review", review: { reason: "baselineReset", findings: [], summary } }
	)
}

const RULE_HOLDS: ReadonlySet<DesktopSyncHold> = new Set(["ruleFileUnwritable", "ruleFileUndecodable"])

function withHold(holds: readonly DesktopSyncHold[], hold: DesktopSyncHold | null, clear: ReadonlySet<DesktopSyncHold>): DesktopSyncHold[] {
	const kept = holds.filter(entry => !clear.has(entry))

	return hold === null || kept.includes(hold) ? kept : [...kept, hold]
}

// What the rule file held when it was read: its bytes and mode; null when there was none.
interface RuleFileRead {
	bytes: Buffer
	mode: number
}

// Reads the rule file only when it is a regular file of its own: a link or anything else is never replaced (a link
// could lead out of the pair).
async function readRuleFile(file: string): Promise<RuleFileRead | null | "unwritable"> {
	let stats

	try {
		stats = await lstat(file)
	} catch (error) {
		return errorCode(error) === "ENOENT" ? null : "unwritable"
	}

	if (!stats.isFile()) {
		return "unwritable"
	}

	try {
		return { bytes: await readFile(file), mode: stats.mode & 0o7777 }
	} catch {
		return "unwritable"
	}
}

function sameRead(a: RuleFileRead | null | "unwritable", b: RuleFileRead | null): boolean {
	return a === null || b === null || a === "unwritable" ? a === b : a.mode === b.mode && a.bytes.equals(b.bytes)
}

// The rule file's text, a BOM kept as it is; null when it is no UTF-8 text.
function decodeRules(bytes: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
	} catch {
		return null
	}
}

// Tries of a rule file the user keeps changing while it is written.
const RULE_WRITE_TRIES = 3

// Makes the pair's root .filenignore hold `rules`; the user's lines and the file's mode stay. A file that is no UTF-8
// text, or no regular file, is never rewritten. The new text is written beside the bin (which never syncs) and renamed
// into place only while the file is still what was read, so no partial file, temporary sibling or concurrent edit is
// ever lost or synced.
export async function ensureRules(localRoot: string, rules: readonly string[]): Promise<DesktopSyncHold | null> {
	const file = path.join(localRoot, ".filenignore")

	for (let attempt = 0; attempt < RULE_WRITE_TRIES; attempt++) {
		const read = await readRuleFile(file)

		if (read === "unwritable") {
			return "ruleFileUnwritable"
		}

		const text = read === null ? "" : decodeRules(read.bytes)

		if (text === null) {
			return "ruleFileUndecodable"
		}

		const next = withRules(text, [rules])

		if (next === text) {
			return null
		}

		const bin = path.join(localRoot, BIN_DIR)
		const temp = path.join(bin, `.filenignore.${randomBytes(6).toString("hex")}`)

		try {
			await mkdir(bin, { recursive: true })
			await writeFile(temp, next)

			if (read !== null) {
				await chmod(temp, read.mode)
			}

			// Changed meanwhile: read it again.
			if (!sameRead(await readRuleFile(file), read)) {
				await rm(temp, { force: true })

				continue
			}

			await rename(temp, file)

			return null
		} catch {
			await rm(temp, { force: true }).catch(() => undefined)

			return "ruleFileUnwritable"
		}
	}

	return "ruleFileUnwritable"
}

// Writes a migrated pair's rules, holding it while they cannot be; true when they are in place.
async function rulesInPlace(deps: FirstRunDeps, pair: ShellPair, localRoot: string): Promise<boolean> {
	if (pair.legacyRules === null) {
		return true
	}

	const hold = await ensureRules(localRoot, pair.legacyRules)
	const holds = withHold(pair.holds, hold, RULE_HOLDS)
	const id = shellPairId(pair)

	if (hold !== null) {
		deps.log.warn(`sync: a pair's .filenignore is not in place: ${hold}`)
	}

	if (holds.length !== pair.holds.length || holds.some((entry, index) => entry !== pair.holds[index])) {
		await patchPair(deps.store, entry => shellPairId(entry) === id, { holds })
	}

	return hold === null
}

export type MigratedStart = "started" | "settled" | "waiting"

// Starts a preparing pair, or holds it in review. `waiting` when it stays preparing, to be tried again: its cloud
// directory is not read yet, its rule file is not in place, the user changed it meanwhile, or a call failed.
async function startMigrated(deps: FirstRunDeps, pairId: string): Promise<MigratedStart> {
	const current = () => deps.store.get().pairs.find(entry => entry.pairId === pairId)
	const pair = current()

	// Removed, or settled meanwhile.
	if (pair?.state !== "preparing") {
		return "settled"
	}

	if (!(await rulesInPlace(deps, pair, pair.localRoot))) {
		return "waiting"
	}

	const plan = await evaluate(deps, pairId)

	if (plan === null) {
		return "waiting"
	}

	const after = current()

	// Paused, switched or removed by the user during the dry run: decided again from what it is now.
	if (after?.state !== "preparing" || after.paused !== pair.paused || after.mode !== pair.mode) {
		return after?.state === "preparing" ? "waiting" : "settled"
	}

	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, entry => entry.pairId === pairId, fields)
	const verdict = migratedVerdict(plan, pair.mode)

	if (!verdict.start) {
		deps.log.info(`sync: a migrated pair waits for review (${verdict.findings.join(", ")})`)
		await patch({ paused: true, state: "review", review: { reason: "migrated", findings: verdict.findings, summary: plan.summary } })

		return "settled"
	}

	const guarded = await deps.call("setMigratedGuard", { pairId })

	if (!guarded.ok) {
		deps.log.warn(`sync: a migrated pair's delete guard was not set: ${guarded.error.code}`)

		return "waiting"
	}

	const settled: Partial<ShellPair> = { state: "active", review: null, legacyRules: null, holds: [] }

	if (pair.paused) {
		await patch(settled)

		return "settled"
	}

	deps.starting(pairId)

	const resumed = await deps.call("resume", { pairId })

	if (!resumed.ok) {
		deps.starting(null)
		deps.log.warn(`sync: a migrated pair was not started: ${resumed.error.code}`)

		return "waiting"
	}

	await patch({ ...settled, paused: false })

	return "started"
}

// Moves the preparing pairs on, one at a time: the first whose cloud directory is read is dry-run and started, held in
// review, or kept for later. `started`: the pair whose first pass now runs (no other starts before it ends);
// `waiting`: some pair still waits.
export async function startPreparing(deps: FirstRunDeps): Promise<{ started: string | null; waiting: boolean }> {
	let waiting = false

	for (const candidate of deps.store.get().pairs) {
		if (candidate.state !== "preparing" || candidate.pairId === null) {
			continue
		}

		const { pairId } = candidate
		const read = await deps.call("awaitConverged", { pairId })
		const pair = deps.store.get().pairs.find(entry => entry.pairId === pairId)

		if (pair === undefined) {
			continue
		}

		if (!read.ok || !read.value) {
			const rounds = (deps.listingRounds.get(pairId) ?? 0) + 1

			deps.listingRounds.set(pairId, rounds)

			if (rounds >= SLOW_LISTING_ROUNDS && !pair.holds.includes("cloudListingSlow")) {
				await patchPair(deps.store, entry => entry.pairId === pairId, { holds: [...pair.holds, "cloudListingSlow"] })
			}

			waiting = true

			continue
		}

		deps.listingRounds.delete(pairId)

		if (pair.holds.includes("cloudListingSlow")) {
			await patchPair(deps.store, entry => entry.pairId === pairId, {
				holds: pair.holds.filter(hold => hold !== "cloudListingSlow")
			})
		}

		const outcome = await startMigrated(deps, pairId)

		if (outcome === "started") {
			return { started: pairId, waiting: true }
		}

		if (outcome === "waiting") {
			waiting = true
		}
	}

	return { started: null, waiting }
}

// Refusals no retry changes, and the notice each one is told with: the pair is kept, never added again, until the
// user dismisses the notice (which removes it).
const REFUSED: Partial<Record<DesktopSyncErrorCode, DesktopSyncNotice>> = {
	rootRefused: "refusedLocalRoot",
	remoteRootMissing: "refusedRemoteMissing",
	localRootInUse: "refusedLocalOverlap",
	localRootNested: "refusedLocalOverlap",
	localRootContains: "refusedLocalOverlap",
	remoteRootInUse: "refusedRemoteOverlap",
	remoteRootNested: "refusedRemoteOverlap",
	remoteRootContains: "refusedRemoteOverlap",
	modeConflict: "refusedModeConflict"
}

// The real path of an existing directory; null when it is missing (an unplugged drive), which is never created.
async function realDirectory(localRoot: string): Promise<string | null> {
	try {
		const real = await realpath(localRoot)

		return (await stat(real)).isDirectory() ? real : null
	} catch {
		return null
	}
}

// Adds one pair the engine does not hold. The real path is recorded and the pair put in review (a migrated one in
// preparing) before the engine gets it, so a crash in between leaves a pair the next `ready` matches and keeps paused.
// A migrated pair is checked like a pair the user adds, and gets its rule file first; one that syncs the whole drive
// waits for the user before the engine lists anything of it.
async function attach(deps: FirstRunDeps, pair: ShellPair): Promise<void> {
	const id = shellPairId(pair)
	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, entry => shellPairId(entry) === id, fields)
	const migrated = pair.legacyUuid !== null && (pair.state === "waitingForRoot" || pair.state === "preparing")
	const localRoot = await realDirectory(pair.localRoot)

	if (localRoot === null) {
		if (pair.state !== "waitingForRoot") {
			await patch({ state: "waitingForRoot", review: null })
		}

		return
	}

	if (migrated) {
		const context = await deps.rootContext()
		const pairRoots = deps.store
			.get()
			.pairs.filter(
				other => other.pairId !== null && shellPairId(other) !== id && !samePath(other.localRoot, localRoot, context.platform)
			)
			.map(other => other.localRoot)
		const inspected = await inspectLocalRoot(localRoot, { ...context, pairRoots })

		if (inspected.problem !== null) {
			deps.log.warn(`sync: a migrated pair's local directory is refused: ${inspected.problem}`)
			await patch({
				state: "unsupported",
				review: null,
				rootProblem: inspected.problem,
				notices: [...pair.notices, "refusedLocalRoot"]
			})

			return
		}

		if (!pair.wholeDriveConfirmed && deps.driveRoot !== null && pair.remoteRoot.toLowerCase() === deps.driveRoot.toLowerCase()) {
			await patch({ state: "preparing", review: null, holds: withHold(pair.holds, "driveRoot", new Set()) })

			return
		}

		if (!(await rulesInPlace(deps, pair, localRoot))) {
			await patch({ state: "preparing", review: null })

			return
		}
	}

	const review: DesktopSyncReview = { reason: "baselineReset", findings: ["unconverged"], summary: null }
	const held: Partial<ShellPair> = migrated ? { state: "preparing", review: null } : { state: "review", review }
	const restore = { state: pair.state, review: pair.review }

	await patch({ localRoot, ...held })

	const added = await deps.call("addPair", { localRoot, remoteRoot: pair.remoteRoot, mode: pair.mode })

	if (!added.ok) {
		const { code } = added.error
		const refused = REFUSED[code]

		if (code === "localRootMissing") {
			await patch({ state: "waitingForRoot", review: null })
		} else if (refused !== undefined) {
			deps.log.warn(`sync: the engine refuses a pair: ${code}`)
			await patch({ state: "unsupported", review: null, notices: [...pair.notices, refused] })
		} else {
			deps.log.warn(`sync: a pair was not added, tried again later: ${code}`)
			await patch(restore)
		}

		return
	}

	const { pairId } = added.value
	const paused = await deps.call("pause", { pairId })

	if (!paused.ok) {
		deps.log.warn(`sync: a pair was not paused, tried again later: ${paused.error.code}`)
		await deps.call("removePair", { pairId })
		await patch(restore)

		return
	}

	// A preparing pair keeps the user's `paused`; the engine holds it paused regardless.
	await patch({ pairId, localRoot, ...held, ...(migrated ? {} : { paused: true }) })

	if (!migrated) {
		await runFirstRun(deps, pairId, { paused: pair.paused })
	}
}

// Whether attachUnheld has work for the pair: the engine does not hold it, it was not refused, and it is not waiting for
// the user to start a whole-drive pair.
export function attachable(pair: ShellPair): boolean {
	return pair.pairId === null && pair.notices.length === 0 && !pair.holds.includes("driveRoot")
}

// Every pair the engine does not hold, one at a time: migrated ones, ones waiting for their directory and ones a
// baseline reset lost.
export async function attachUnheld(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (attachable(pair)) {
			await attach(deps, pair)
		}
	}
}

// A pair in review or preparing never runs: one the engine holds unpaused (a crash between adding and pausing it) is
// paused. A preparing pair's `paused` is the user's, so it is paused whatever it says, and that stays.
export async function holdReviewed(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (pair.pairId === null || (pair.state !== "preparing" && (pair.state !== "review" || pair.paused))) {
			continue
		}

		const { pairId } = pair
		const paused = await deps.call("pause", { pairId })

		if (!paused.ok) {
			deps.log.warn(`sync: a held pair was not paused: ${paused.error.code}`)
		} else if (pair.state === "review") {
			await patchPair(deps.store, entry => entry.pairId === pairId, { paused: true })
		}
	}
}
