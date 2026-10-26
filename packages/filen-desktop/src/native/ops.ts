import type { SyncPairInfo } from "@filen/sdk-rs"
import { oldWouldIgnore } from "../shared/legacyIgnore.ts"
import type { NativeOpArgs, NativeOpResult, NativePair, SyncOp } from "../shared/nativeProtocol.ts"
import { modeName, type NativeSdk, type SyncEngine, syncMode } from "./addon.ts"
import type { Convergence } from "./convergence.ts"
import { classify, clip, HostError, invalidIgnore } from "./errors.ts"
import { checkPlan } from "./legacyCheck.ts"
import { heldReason, planPage, type PlanRegistry, toAction, toConflict, toIgnored, toSummary } from "./plans.ts"
import type { RuntimeFeed } from "./reducer.ts"

// How long a dry run waits for the cache to converge on the pair's remote root: well inside main's call timeout, which
// also has to cover the plan itself.
export const CONVERGENCE_TIMEOUT_MS = 60_000

export interface OpsContext {
	sdk: NativeSdk
	engine: SyncEngine
	// The account's root directory, which no pair may sync.
	rootUuid: string
	feed: RuntimeFeed
	plans: PlanRegistry
	convergence: Convergence
	// Aborted on shutdown.
	signal: AbortSignal
	convergenceTimeoutMs?: number
}

export type OpHandlers = { [K in SyncOp]: (args: NativeOpArgs<K>) => Promise<NativeOpResult<K>> }

export interface HostEngine {
	ops: OpHandlers
	// Reads the pairs back from the engine; every change to them goes through here.
	refreshPairs(): Promise<SyncPairInfo[]>
	// Starts a watch for every listed pair that runs and has none, a failure reported per pair; resolves with the pairs.
	watchAll(onError: (error: unknown) => void): Promise<SyncPairInfo[]>
	// A watch ended (stopped, or its pair removed).
	watchEnded(pairId: bigint): void
}

export function toNativePair(sdk: NativeSdk, info: SyncPairInfo): NativePair {
	return {
		id: info.id.toString(),
		localRoot: info.localRoot,
		remoteRoot: info.remoteRoot,
		mode: modeName(sdk, info.mode),
		paused: info.paused
	}
}

const NO_HELD = { passToken: null, reason: null, total: 0, entries: [] }

// One handler per protocol op. Pair ids arrive as validated decimal strings and become the engine's bigints here; a
// pair the engine does not list is `pairNotFound` before any engine call.
export function createHostEngine(ctx: OpsContext): HostEngine {
	const { sdk, engine, feed, plans } = ctx
	// The pairs with a watch this process started; the engine owns the watches themselves.
	const watched = new Set<string>()
	let defaults: string[] | null = null

	async function refreshPairs(): Promise<SyncPairInfo[]> {
		const infos = await engine.listPairs()

		feed.setPairs(infos)

		return infos
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

	async function changed(): Promise<null> {
		await refreshPairs()

		return null
	}

	const ops: OpHandlers = {
		listPairs: async () => (await refreshPairs()).map(info => toNativePair(sdk, info)),
		addPair: async ({ localRoot, remoteRoot, mode }) => {
			if (remoteRoot.toLowerCase() === ctx.rootUuid.toLowerCase()) {
				throw new HostError({ code: "accountRoot" })
			}

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
			await engine.removePair(held(pairId).id)
			watched.delete(pairId)

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
		// A paused pair without a watch gets its pass when it resumes.
		requestPass: async ({ pairId }) => {
			const { id, info } = held(pairId)

			if (watched.has(pairId)) {
				await engine.requestPass(id)
			} else if (!info.paused) {
				await watch(id)
			}

			return null
		},
		evaluatePlan: async ({ pairId, check }) => {
			const { id, info } = held(pairId)

			if (!(await ctx.convergence.awaitConverged(info.remoteRoot, ctx.convergenceTimeoutMs ?? CONVERGENCE_TIMEOUT_MS, ctx.signal))) {
				return { status: "unconverged" }
			}

			const plan = await engine.planPair(id)
			const planId = plans.put(plan)
			const legacy = check?.legacy ?? null

			return {
				status: "ok",
				planId,
				summary: toSummary(sdk, plan.summary()),
				check: check === undefined ? null : checkPlan(plan, legacy === null ? null : relPath => oldWouldIgnore(relPath, legacy))
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
						entries: report.held.map(action => toAction(sdk, action))
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
		},
		// The engine has no way yet to seed a pair from the old client's state.
		seedLegacy: async ({ pairId }) => {
			held(pairId)

			return "unsupported"
		}
	}

	return {
		ops,
		refreshPairs,
		watchAll: async onError => {
			const infos = await refreshPairs()

			await Promise.all(
				infos.filter(info => !info.paused && !watched.has(info.id.toString())).map(info => watch(info.id).catch(onError))
			)

			return infos
		},
		watchEnded: pairId => {
			watched.delete(pairId.toString())
		}
	}
}
