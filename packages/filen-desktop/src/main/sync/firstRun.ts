import { readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
	DesktopSyncErrorCode,
	DesktopSyncNotice,
	DesktopSyncPlanSummary,
	DesktopSyncReview,
	DesktopSyncReviewFinding
} from "@filen/shared/desktop"
import type { NativeOpArgs, SyncOp } from "../../shared/nativeProtocol.ts"
import { errorCode } from "../atomicFile.ts"
import type { NativeResult } from "../native/rpc.ts"
import { DOT_FILE_RULES, withRules } from "./legacyPairs.ts"
import { shellPairId } from "./mirror.ts"
import type { ShellPair, SyncStore } from "./store.ts"

// The first run of a pair the user did not just add (PLAN §6.6). A migrated pair starts by itself once its cloud
// directory is read; only a one-way pair that would overwrite a lot on its destination waits in review. One a baseline
// reset lost is dry-run and starts only when that run is close to nothing, else it waits in review. Conflicts and held
// deletions of a started pair are the engine's to hold, shown with the pair's issues.

export interface FirstRunDeps {
	// Engine calls for the user this run is for; another user's host answers none of them.
	call<K extends SyncOp>(op: K, args: NativeOpArgs<K>): Promise<NativeResult<K>>
	store: SyncStore
	now(): number
	log: { info(message: string): void; warn(message: string): void }
}

export const FIRST_RUN_LIMITS = { maxBytes: 1_048_576, maxTransfers: 25 }

// A migrated one-way pair waits in review when its first run would overwrite more than either on its destination.
export const MAX_OVERWRITE_BYTES = 1_073_741_824
export const MAX_OVERWRITE_FILES = 1000

export interface FirstRunPlan {
	summary: DesktopSyncPlanSummary
	// The plan's upload and download actions.
	uploads: number
	downloads: number
}

export type FirstRunVerdict = { start: true } | { start: false; findings: DesktopSyncReviewFinding[] }

// `plan` is null when the remote side had not converged, so nothing could be planned.
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

// A migrated one-way pair's verdict. `overwrites` is null when the host could not tell, which is held too.
export function overwriteVerdict(overwrites: { files: number; bytes: number } | null): FirstRunVerdict {
	return overwrites !== null && overwrites.files <= MAX_OVERWRITE_FILES && overwrites.bytes <= MAX_OVERWRITE_BYTES
		? { start: true }
		: { start: false, findings: ["overwrites"] }
}

function patchPair(store: SyncStore, matches: (pair: ShellPair) => boolean, patch: Partial<ShellPair>): Promise<unknown> {
	return store.update(state => ({ ...state, pairs: state.pairs.map(pair => (matches(pair) ? { ...pair, ...patch } : pair)) }))
}

// The pair (an engine id) is held and paused already. A failed call leaves it paused in the review it has.
export async function runFirstRun(deps: FirstRunDeps, pairId: string, options: { paused: boolean }): Promise<void> {
	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, pair => pair.pairId === pairId, fields)
	const evaluated = await deps.call("evaluatePlan", { pairId, check: { overwrites: false } })

	if (!evaluated.ok) {
		deps.log.warn(`sync: first run not planned: ${evaluated.error.code}`)

		return
	}

	let plan: FirstRunPlan | null = null

	if (evaluated.value.status === "ok") {
		const { planId, summary: native, check } = evaluated.value
		const { passToken: _passToken, ...summary } = native

		await deps.call("releasePlan", { planId })
		// A host that skipped the scan leaves every action in doubt.
		plan = { summary, uploads: check?.uploads ?? summary.actions, downloads: check?.downloads ?? summary.actions }
	}

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

// Starts a preparing pair, or holds it in review. False when it stays preparing, to be tried again: its cloud
// directory is not read yet (a one-way pair is never planned against a partial view, a two-way one never started on
// one), or a call failed.
async function startMigrated(deps: FirstRunDeps, pairId: string, converged: boolean): Promise<boolean> {
	const pair = deps.store.get().pairs.find(entry => entry.pairId === pairId)

	// Removed, or settled meanwhile.
	if (pair?.state !== "preparing") {
		return true
	}

	if (!converged) {
		return false
	}

	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, entry => entry.pairId === pairId, fields)

	if (pair.mode !== "twoWay") {
		const evaluated = await deps.call("evaluatePlan", { pairId, check: { overwrites: true } })

		if (!evaluated.ok) {
			deps.log.warn(`sync: a migrated pair was not planned: ${evaluated.error.code}`)

			return false
		}

		if (evaluated.value.status === "unconverged") {
			return false
		}

		const { planId, summary: native, check } = evaluated.value
		const { passToken: _passToken, ...summary } = native

		await deps.call("releasePlan", { planId })

		const overwrites = check?.overwrites ?? null
		const verdict = overwriteVerdict(overwrites)

		if (!verdict.start) {
			deps.log.info(
				`sync: a migrated pair waits for review: it would overwrite ${String(overwrites?.files ?? "?")} files (${String(overwrites?.bytes ?? "?")} bytes)`
			)
			await patch({ paused: true, state: "review", review: { reason: "migrated", findings: verdict.findings, summary } })

			return true
		}
	}

	if (pair.paused) {
		await patch({ state: "active", review: null })

		return true
	}

	const resumed = await deps.call("resume", { pairId })

	if (!resumed.ok) {
		deps.log.warn(`sync: a migrated pair was not started: ${resumed.error.code}`)

		return false
	}

	await patch({ paused: false, state: "active", review: null })

	return true
}

// Every preparing pair the engine holds, their cloud directories awaited together. True when some still wait.
export async function startPreparing(deps: FirstRunDeps): Promise<boolean> {
	const pairIds = deps.store.get().pairs.flatMap(pair => (pair.state === "preparing" && pair.pairId !== null ? [pair.pairId] : []))
	const converged = await Promise.all(pairIds.map(pairId => deps.call("awaitConverged", { pairId })))
	let waiting = false

	for (const [index, pairId] of pairIds.entries()) {
		const read = converged[index]

		if (!(await startMigrated(deps, pairId, read?.ok === true && read.value))) {
			waiting = true
		}
	}

	return waiting
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
	remoteRootContains: "refusedRemoteOverlap"
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

// Appends the rules a rule file lacks; the user's lines stay.
async function ensureRules(file: string, blocks: readonly (readonly string[])[]): Promise<void> {
	let text = ""

	try {
		text = await readFile(file, "utf8")
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			throw error
		}
	}

	const next = withRules(text, blocks)

	if (next !== text) {
		await writeFile(file, next)
	}
}

// Adds one pair the engine does not hold. The real path is recorded and the pair put in review (a migrated one in
// preparing) before the engine gets it, so a crash in between leaves a pair the next `ready` matches and keeps paused.
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
			deps.log.warn(`sync: a pair was not added, retried on the next start: ${code}`)
			await patch(restore)
		}

		return
	}

	const { pairId } = added.value
	const paused = await deps.call("pause", { pairId })

	if (!paused.ok) {
		deps.log.warn(`sync: a pair was not paused, retried on the next start: ${paused.error.code}`)
		await deps.call("removePair", { pairId })
		await patch(restore)

		return
	}

	// A preparing pair keeps the user's `paused`; the engine holds it paused regardless.
	await patch({ pairId, localRoot, ...held, ...(migrated ? {} : { paused: true }) })

	if (!migrated) {
		await runFirstRun(deps, pairId, { paused: pair.paused })

		return
	}

	// The pair's own rule file, written before it first runs (startPreparing starts it).
	if (pair.legacyDotFiles === "pair") {
		await ensureRules(path.join(localRoot, ".filenignore"), [DOT_FILE_RULES]).catch((error: unknown) => {
			deps.log.warn(`sync: the pair's .filenignore was not written: ${errorCode(error)}`)
		})
	}
}

// Every pair the engine does not hold, one at a time: migrated ones, ones waiting for their directory and ones a
// baseline reset lost. A pair the engine refused waits for the user.
export async function attachUnheld(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (pair.pairId === null && pair.notices.length === 0) {
			await attach(deps, pair)
		}
	}
}

// A pair in review or preparing never runs: one the engine holds unpaused (a crash between adding and pausing it) is
// paused. A preparing pair's `paused` is the user's, so it is paused whatever it says, and that stays.
export async function holdReviewed(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (pair.pairId === null) {
			continue
		}

		const { pairId } = pair

		if (pair.state === "preparing") {
			await deps.call("pause", { pairId })
		} else if (pair.state === "review" && !pair.paused) {
			const paused = await deps.call("pause", { pairId })

			if (paused.ok) {
				await patchPair(deps.store, entry => entry.pairId === pairId, { paused: true })
			}
		}
	}
}
