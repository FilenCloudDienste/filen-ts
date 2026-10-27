import { readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
	DesktopSyncErrorCode,
	DesktopSyncPlanSummary,
	DesktopSyncRefusedNotice,
	DesktopSyncReview,
	DesktopSyncReviewFinding
} from "@filen/shared/desktop"
import type { NativeOpArgs, SyncOp } from "../../shared/nativeProtocol.ts"
import { errorCode } from "../atomicFile.ts"
import type { NativeResult } from "../native/rpc.ts"
import { DOT_FILE_RULES, withRules } from "./legacyPairs.ts"
import { shellPairId } from "./mirror.ts"
import { isRefusedNotice, type ShellPair, type SyncStore } from "./store.ts"

// The first run of a pair the user did not just add (PLAN §6.6): a migrated pair, or one a baseline reset lost. It is
// added paused and dry-run; it starts by itself only when that run is close to nothing, else it waits in review.

export interface FirstRunDeps {
	// Engine calls for the user this run is for; another user's host answers none of them.
	call<K extends SyncOp>(op: K, args: NativeOpArgs<K>): Promise<NativeResult<K>>
	store: SyncStore
	// The old client's state directory of a pair it had (by its uuid there).
	legacyStateDir(legacyUuid: string): string
	now(): number
	log: { info(message: string): void; warn(message: string): void }
}

export const FIRST_RUN_LIMITS = { maxBytes: 1_048_576, maxTransfers: 25 }

export interface FirstRunPlan {
	summary: DesktopSyncPlanSummary
	// The plan's upload and download actions.
	uploads: number
	downloads: number
	// Paths the plan would sync that the old client's rules hid.
	legacyHits: number
}

export type FirstRunVerdict = { start: true } | { start: false; findings: DesktopSyncReviewFinding[] }

// `plan` is null when the remote side had not converged, so nothing could be planned.
export function firstRunVerdict(
	plan: FirstRunPlan | null,
	dotFilesPerPair: boolean,
	limits: { maxBytes: number; maxTransfers: number } = FIRST_RUN_LIMITS
): FirstRunVerdict {
	const findings: DesktopSyncReviewFinding[] = []

	if (plan === null) {
		findings.push("unconverged")
	} else {
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

		if (plan.legacyHits > 0) {
			findings.push("newlySynced")
		}
	}

	if (dotFilesPerPair) {
		findings.push("dotFilesPerPair")
	}

	return findings.length === 0 ? { start: true } : { start: false, findings }
}

export interface FirstRunOptions {
	reason: DesktopSyncReview["reason"]
	// The user had the pair paused: it stays paused even when the run is clean.
	paused: boolean
	// The old client's rules to check the plan against (migrated pairs only).
	legacy: { excludeDotFiles: boolean } | null
	dotFilesPerPair: boolean
}

function patchPair(store: SyncStore, matches: (pair: ShellPair) => boolean, patch: Partial<ShellPair>): Promise<unknown> {
	return store.update(state => ({ ...state, pairs: state.pairs.map(pair => (matches(pair) ? { ...pair, ...patch } : pair)) }))
}

// The pair (an engine id) is held and paused already. A failed call leaves it paused in the review it has.
export async function runFirstRun(deps: FirstRunDeps, pairId: string, options: FirstRunOptions): Promise<void> {
	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, pair => pair.pairId === pairId, fields)
	const evaluated = await deps.call("evaluatePlan", { pairId, check: { legacy: options.legacy } })

	if (!evaluated.ok) {
		deps.log.warn(`sync: first run not planned: ${evaluated.error.code}`)

		return
	}

	let plan: FirstRunPlan | null = null

	if (evaluated.value.status === "ok") {
		const { planId, summary: native, check } = evaluated.value
		const { passToken: _passToken, ...summary } = native

		await deps.call("releasePlan", { planId })
		// A host that skipped the scan leaves every action and path in doubt.
		plan = {
			summary,
			uploads: check?.uploads ?? summary.actions,
			downloads: check?.downloads ?? summary.actions,
			legacyHits: options.legacy === null ? 0 : (check?.legacyHits?.count ?? 1)
		}
	}

	const verdict = firstRunVerdict(plan, options.dotFilesPerPair)
	const summary = plan?.summary ?? null

	if (!verdict.start) {
		await patch({ paused: true, state: "review", review: { reason: options.reason, findings: verdict.findings, summary } })

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
			: { paused: true, state: "review", review: { reason: options.reason, findings: [], summary } }
	)
}

// Best effort: a pair the import fails for (the host logs why) is planned without it.
async function seedLegacy(deps: FirstRunDeps, pairId: string, legacyUuid: string): Promise<void> {
	const seeded = await deps.call("seedLegacy", { pairId, stateDir: deps.legacyStateDir(legacyUuid) })

	if (!seeded.ok) {
		deps.log.warn(`sync: the previous app's state was not imported: ${seeded.error.code}`)
	} else if (seeded.value !== null) {
		deps.log.info(`sync: imported ${String(seeded.value.imported)} entries of the previous app's state`)
	}
}

// Refusals no retry changes, and the notice each one is told with: the pair is kept, never added again, until the
// user dismisses the notice (which removes it).
const REFUSED: Partial<Record<DesktopSyncErrorCode, DesktopSyncRefusedNotice>> = {
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

// Adds one pair the engine does not hold. The real path is recorded and the pair put in review before the engine
// gets it, so a crash in between leaves a pair the next `ready` matches and keeps paused in review.
async function attach(deps: FirstRunDeps, pair: ShellPair): Promise<void> {
	const id = shellPairId(pair)
	const patch = (fields: Partial<ShellPair>) => patchPair(deps.store, entry => shellPairId(entry) === id, fields)
	const migrated = pair.legacyUuid !== null && pair.state === "waitingForRoot"
	const reason = migrated ? "migrated" : "baselineReset"
	const dotFilesPerPair = migrated && pair.legacyDotFiles === "pair"
	const localRoot = await realDirectory(pair.localRoot)

	if (localRoot === null) {
		if (pair.state !== "waitingForRoot") {
			await patch({ state: "waitingForRoot", review: null })
		}

		return
	}

	const review: DesktopSyncReview = {
		reason,
		findings: dotFilesPerPair ? ["unconverged", "dotFilesPerPair"] : ["unconverged"],
		summary: null
	}
	const restore = { state: pair.state, review: pair.review }

	await patch({ localRoot, state: "review", review })

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

	await patch({ pairId, localRoot, paused: true, state: "review", review })

	// The pair's own rule file, written before its first plan; it syncs only once the user starts the pair.
	if (dotFilesPerPair) {
		await ensureRules(path.join(localRoot, ".filenignore"), [DOT_FILE_RULES]).catch((error: unknown) => {
			deps.log.warn(`sync: the pair's .filenignore was not written: ${errorCode(error)}`)
		})
	}

	// Before the first plan, so the old client's evidence keeps a migrated pair's first run from transferring what it
	// had in sync. Also after a baseline reset, which emptied the baseline the engine would refuse to seed.
	if (pair.legacyUuid !== null) {
		await seedLegacy(deps, pairId, pair.legacyUuid)
	}

	await runFirstRun(deps, pairId, {
		reason,
		paused: pair.paused,
		legacy: migrated ? { excludeDotFiles: pair.legacyDotFiles !== null } : null,
		dotFilesPerPair
	})
}

// Every pair the engine does not hold, one at a time: migrated ones, ones waiting for their directory and ones a
// baseline reset lost. A pair the engine refused waits for the user.
export async function attachUnheld(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (pair.pairId === null && !pair.notices.some(isRefusedNotice)) {
			await attach(deps, pair)
		}
	}
}

// A pair in review never runs: one the engine holds unpaused (a crash between adding and pausing it) is paused.
export async function holdReviewed(deps: FirstRunDeps): Promise<void> {
	for (const pair of deps.store.get().pairs) {
		if (pair.state === "review" && pair.pairId !== null && !pair.paused) {
			const { pairId } = pair
			const paused = await deps.call("pause", { pairId })

			if (paused.ok) {
				await patchPair(deps.store, entry => entry.pairId === pairId, { paused: true })
			}
		}
	}
}
