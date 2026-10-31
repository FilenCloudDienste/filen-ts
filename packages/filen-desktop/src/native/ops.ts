import type { DeleteGuardState, SyncPairInfo, SyncPassReport } from "@filen/sdk-rs"
import type { NativeOpArgs, NativeOpResult, NativePair, SyncOp } from "../shared/nativeProtocol.ts"
import { modeName, type NativeSdk, type SyncEngine, syncMode } from "./addon.ts"
import type { Convergence } from "./convergence.ts"
import { classify, clip, HostError, invalidIgnore } from "./errors.ts"
import { checkPlan } from "./planCheck.ts"
import { heldReason, planPage, type PlanRegistry, toAction, toConflict, toIgnored, toScanGap, toSummary, toUnsyncable } from "./plans.ts"
import type { RuntimeFeed } from "./reducer.ts"

// How long a dry run (or awaitConverged) waits for the cache to converge on the pair's remote root: well inside main's
// call timeout, which also has to cover the plan itself.
export const CONVERGENCE_TIMEOUT_MS = 60_000

export interface OpsContext {
	sdk: NativeSdk
	engine: SyncEngine
	feed: RuntimeFeed
	plans: PlanRegistry
	convergence: Convergence
	// Aborted on shutdown.
	signal: AbortSignal
	convergenceTimeoutMs?: number
	log: { info(message: string): void; warn(message: string): void }
}

export type OpHandlers = { [K in SyncOp]: (args: NativeOpArgs<K>) => Promise<NativeOpResult<K>> }

export interface HostEngine {
	ops: OpHandlers
	// Reads the pairs back from the engine; every change to them goes through here.
	refreshPairs(): Promise<SyncPairInfo[]>
	// Pauses the pairs main holds back (by remote root, which no two pairs share), then starts a watch for every listed pair that runs and has none, a
	// failure reported per pair; resolves with the pairs.
	watchAll(holdRemotes: readonly string[], onError: (error: unknown) => void): Promise<SyncPairInfo[]>
	// A watch ended (stopped, or its pair removed).
	watchEnded(pairId: bigint): void
	// A pass ended, with its report (none for a pass that failed): lifts the migrated guard once it is no longer needed.
	passEnded(pairId: bigint, report: SyncPassReport | null): Promise<void>
}

// The guard a migrated pair runs on (setMigratedGuard): every deletion held.
const MIGRATED_GUARD = { floor: 0n, ratio: 0 }
// The engine's guard for a new pair, which a migrated one gets back.
const DEFAULT_GUARD = { floor: 10n, ratio: 0.5 }

function isMigratedGuard(guard: DeleteGuardState | undefined): boolean {
	return guard?.tag === "Limited" && guard.inner.floor === MIGRATED_GUARD.floor && guard.inner.ratio === MIGRATED_GUARD.ratio
}

// Whether a pass left nothing behind: it ran whole and held no deletion.
function settled(report: SyncPassReport): boolean {
	return (
		report.heldDeletions === 0n &&
		report.passError === undefined &&
		report.refused === undefined &&
		!report.paused &&
		report.interrupted === 0n
	)
}

export function toNativePair(sdk: NativeSdk, info: SyncPairInfo): NativePair {
	return {
		id: info.id.toString(),
		localRoot: info.localRoot,
		remoteRoot: info.remoteRoot,
		mode: modeName(sdk, info.mode),
		paused: info.paused,
		firstPassCompleted: info.firstPassCompleted
	}
}

const NO_HELD = { passToken: null, reason: null, total: 0, entries: [], gaps: [], gapsTotal: 0 }

// One handler per protocol op. Pair ids arrive as validated decimal strings and become the engine's bigints here; a
// pair the engine does not list is `pairNotFound` before any engine call.
export function createHostEngine(ctx: OpsContext): HostEngine {
	const { sdk, engine, feed, plans } = ctx
	// The pairs with a watch this process started; the engine owns the watches themselves.
	const watched = new Set<string>()
	// The pairs whose held conflicts were counted once (a pass this process saw counts them afterwards).
	const seeded = new Set<string>()
	let defaults: string[] | null = null

	async function refreshPairs(): Promise<SyncPairInfo[]> {
		const infos = await engine.listPairs()

		feed.setPairs(infos)

		const fresh = infos.filter(info => !seeded.has(info.id.toString()))

		for (const info of fresh) {
			seeded.add(info.id.toString())
		}

		// The count only; read from the baseline, no network.
		await Promise.all(
			fresh.map(async info => {
				try {
					feed.seedConflicts(info.id.toString(), Number((await engine.listConflicts(info.id, 0n, 0n)).total))
				} catch (error) {
					const failure = classify(sdk, error)

					ctx.log.warn(`sync: conflicts not counted: ${failure === "unauthenticated" ? failure : failure.code}`)
				}
			})
		)

		return infos
	}

	function isStale(error: unknown): boolean {
		return sdk.FilenSdkError.hasInner(error) && sdk.FilenSdkError.getInner(error).kind() === sdk.ErrorKind.StaleState
	}

	function held(pairId: string): { id: bigint; info: SyncPairInfo } {
		const info = feed.pair(pairId)

		if (info === undefined) {
			throw new HostError({ code: "pairNotFound", pairId })
		}

		return { id: info.id, info }
	}

	async function watch(id: bigint): Promise<void> {
		await engine.watchPair(id, undefined)
		watched.add(id.toString())
	}

	function converged(info: SyncPairInfo): Promise<boolean> {
		return ctx.convergence.awaitConverged(info.remoteRoot, ctx.convergenceTimeoutMs ?? CONVERGENCE_TIMEOUT_MS, ctx.signal)
	}

	async function changed(): Promise<null> {
		await refreshPairs()

		return null
	}

	const ops: OpHandlers = {
		listPairs: async () => (await refreshPairs()).map(info => toNativePair(sdk, info)),
		addPair: async ({ localRoot, remoteRoot, mode }) => {
			let id: bigint

			try {
				id = await engine.addPair(localRoot, remoteRoot, syncMode(sdk, mode))
			} catch (error) {
				// The local root no longer resolves to a directory.
				if (
					sdk.FilenSdkError.hasInner(error) &&
					sdk.FilenSdkError.getInner(error).kind() === sdk.ErrorKind.Io &&
					sdk.FilenSdkError.getInner(error).syncRefusal() === undefined
				) {
					throw new HostError({ code: "localRootMissing" })
				}

				throw error
			}

			await refreshPairs()

			return { pairId: id.toString() }
		},
		removePair: async ({ pairId }) => {
			const { id, info } = held(pairId)

			await engine.removePair(id)
			watched.delete(pairId)
			seeded.delete(pairId)
			ctx.convergence.forget(info.remoteRoot)

			return changed()
		},
		pause: async ({ pairId }) => {
			await engine.pausePair(held(pairId).id, undefined)

			return changed()
		},
		// A pair paused when the engine opened has no watch; resuming starts one, whose first pass runs at once.
		resume: async ({ pairId }) => {
			const { id } = held(pairId)

			await engine.resumePair(id)

			if (!watched.has(pairId)) {
				await watch(id)
			}

			return changed()
		},
		setMode: async ({ pairId, mode, backlog }) => {
			await engine.reconfigurePair(
				held(pairId).id,
				syncMode(sdk, mode),
				backlog === "adoptDestination" ? sdk.Backlog.AdoptDestination : sdk.Backlog.Propagate
			)

			return changed()
		},
		// A paused pair gets its pass when it resumes.
		requestPass: async ({ pairId }) => {
			const { id, info } = held(pairId)

			if (info.paused) {
				return null
			}

			if (watched.has(pairId)) {
				await engine.requestPass(id)
			} else {
				await watch(id)
			}

			return null
		},
		awaitConverged: async ({ pairId }) => converged(held(pairId).info),
		evaluatePlan: async ({ pairId, check }) => {
			const { id, info } = held(pairId)

			if (!(await converged(info))) {
				return { status: "unconverged" }
			}

			let plan

			try {
				plan = await engine.planPair(id)
			} catch (error) {
				// The listing started over since: not ready yet.
				if (isStale(error)) {
					return { status: "unconverged" }
				}

				throw error
			}

			const planId = plans.put(plan)

			return {
				status: "ok",
				planId,
				summary: toSummary(sdk, plan.summary()),
				check: check === true ? checkPlan(sdk, plan) : null
			}
		},
		planPage: async ({ planId, list, offset, limit }) => {
			const plan = plans.get(planId)

			if (plan === null) {
				throw new HostError({ code: "planExpired" })
			}

			return planPage(sdk, plan, list, offset, limit)
		},
		releasePlan: async ({ planId }) => {
			plans.release(planId)

			return null
		},
		conflicts: async ({ pairId, offset, limit }) => {
			const page = await engine.listConflicts(held(pairId).id, BigInt(offset), BigInt(limit))

			return { total: Number(page.total), entries: page.conflicts.map(conflict => toConflict(sdk, conflict)) }
		},
		resolveConflict: async ({ pairId, relPath, resolution }) => {
			const kept = await engine.resolveConflict(
				held(pairId).id,
				relPath,
				resolution === "keepLocal"
					? sdk.ConflictResolution.KeepLocal
					: resolution === "keepRemote"
						? sdk.ConflictResolution.KeepRemote
						: sdk.ConflictResolution.KeepBoth
			)

			return kept === undefined ? null : clip(kept)
		},
		// What the last pass this process saw held back; nothing before one ran.
		heldDeletions: async ({ pairId }) => {
			const report = await engine.lastReport(held(pairId).id)

			return report === undefined
				? NO_HELD
				: {
						passToken: report.deletionToken ?? null,
						reason: heldReason(report.guard),
						total: Number(report.heldTotal),
						entries: report.held.map(action => toAction(sdk, action)),
						gaps: report.scanGaps.map(toScanGap),
						gapsTotal: Number(report.scanGapsTotal)
					}
		},
		// The approval only covers the next pass, so one runs now.
		approveDeletions: async ({ pairId, passToken }) => {
			const { id, info } = held(pairId)

			await engine.approveDeletions(id, passToken)

			if (watched.has(pairId) && !info.paused) {
				await engine.requestPass(id)
			}

			return null
		},
		retryPath: async ({ pairId, relPath }) => {
			await engine.retryPath(held(pairId).id, relPath)

			return null
		},
		retryAll: async ({ pairId }) => {
			const { id, info } = held(pairId)

			await engine.retryAll(id)

			if (watched.has(pairId) && !info.paused) {
				await engine.requestPass(id)
			}

			return null
		},
		unsyncablePaths: async ({ pairId, offset, limit }) => {
			const report = await engine.lastReport(held(pairId).id)

			return report === undefined
				? null
				: { total: Number(report.unsyncableTotal), entries: report.unsyncable.slice(offset, offset + limit).map(toUnsyncable) }
		},
		setMigratedGuard: async ({ pairId }) => {
			await engine.setDeleteGuard(held(pairId).id, MIGRATED_GUARD.floor, MIGRATED_GUARD.ratio)

			return changed()
		},
		// From the last pass's report, which keeps the first 1000.
		ignoredPaths: async ({ pairId, offset, limit }) => {
			const report = await engine.lastReport(held(pairId).id)

			return report === undefined
				? { total: 0, entries: [] }
				: { total: Number(report.ignoredTotal), entries: report.ignored.slice(offset, offset + limit).map(toIgnored) }
		},
		userIgnore: async () => engine.userIgnore(),
		setUserIgnore: async ({ text }) => {
			try {
				await engine.setUserIgnore(text)
			} catch (error) {
				const refused = invalidIgnore(classify(sdk, error))

				throw refused === null ? error : new HostError(refused)
			}

			return null
		},
		defaultIgnore: async () => {
			defaults ??= sdk.defaultSyncIgnorePatterns().map(clip)

			return defaults
		}
	}

	return {
		ops,
		refreshPairs,
		watchAll: async (holdRemotes, onError) => {
			const hold = new Set(holdRemotes.map(root => root.toLowerCase()))
			let infos = await refreshPairs()
			const unpaused = infos.filter(info => !info.paused && hold.has(info.remoteRoot.toLowerCase()))

			// A crash between adding such a pair and pausing it left it running; its first pass waits for main.
			if (unpaused.length > 0) {
				await Promise.all(unpaused.map(info => engine.pausePair(info.id, undefined)))
				infos = await refreshPairs()
			}

			await Promise.all(
				infos.filter(info => !info.paused && !watched.has(info.id.toString())).map(info => watch(info.id).catch(onError))
			)

			return infos
		},
		watchEnded: pairId => {
			watched.delete(pairId.toString())
		},
		passEnded: async (pairId, report) => {
			const key = pairId.toString()

			if (report === null || !settled(report) || !isMigratedGuard(feed.pair(key)?.deleteGuard)) {
				return
			}

			const info = (await refreshPairs()).find(entry => entry.id === pairId)

			if (info?.firstPassCompleted === true && isMigratedGuard(info.deleteGuard)) {
				await engine.setDeleteGuard(pairId, DEFAULT_GUARD.floor, DEFAULT_GUARD.ratio)
				await refreshPairs()
				ctx.log.info(`sync: pair ${key} synced cleanly; its deletions are guarded as usual again`)
			}
		}
	}
}
