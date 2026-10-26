import path from "node:path"
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron"
import type {
	DesktopSyncActivity,
	DesktopSyncBacklog,
	DesktopSyncConflict,
	DesktopSyncEntries,
	DesktopSyncErrorCode,
	DesktopSyncHeldDeletions,
	DesktopSyncHostState,
	DesktopSyncIgnored,
	DesktopSyncLocalRootChoice,
	DesktopSyncMode,
	DesktopSyncNewPair,
	DesktopSyncNotice,
	DesktopSyncOverview,
	DesktopSyncPlan,
	DesktopSyncPlanList,
	DesktopSyncPlanPage,
	DesktopSyncResolution,
	DesktopSyncResult,
	DesktopSyncUserIgnore
} from "@filen/shared/desktop"
import { CHANNELS } from "../../shared/channels.ts"
import type { NativeOpArgs, NativePairRuntime, SyncOp } from "../../shared/nativeProtocol.ts"
import type { NativeResult } from "../native/rpc.ts"
import type { NativeEvent, NativeSupervisor } from "../native/supervisor.ts"
import { errorCode } from "../atomicFile.ts"
import { type Page, pushThrottle } from "../pages.ts"
import { serialQueue } from "../serial.ts"
import { createActivityLog } from "./activity.ts"
import { attachUnheld, type FirstRunDeps, holdReviewed } from "./firstRun.ts"
import { applyLegacySync } from "./legacyPairs.ts"
import { chooseLocalDirectory, inspectLocalRoot, type LocalRootContext, type RootTokens } from "./localRoot.ts"
import { reconcileMirror, shellPairId } from "./mirror.ts"
import { mergeOverview } from "./overview.ts"
import { isRefusedNotice, type ShellPair, type SyncStore } from "./store.ts"

// Overview pushes to a page at most this often.
export const OVERVIEW_PUSH_INTERVAL_MS = 250

// Where the engine moves local files it replaced or deleted, inside the pair's root.
const QUARANTINE_DIR = ".filen-sync-trash"

export interface SyncServiceDeps {
	supervisor: Pick<NativeSupervisor, "call" | "subscribe" | "ensure" | "retry" | "user" | "state">
	storeFor(userId: string): Promise<SyncStore>
	tokens: RootTokens
	dialogs: {
		// Bound to the app's window.
		showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
		// Where no pair may be; the pairs and mounts are added here.
		rootContext(): Omit<LocalRootContext, "pairRoots" | "mountPoints">
		// The user's network drive mount points, mounted now or not.
		mountPoints(userId: string): Promise<readonly string[]>
	}
	shell: { openPath(target: string): Promise<string> }
	// The old client's sync config the migration stashed for a user.
	legacySync: { pending(userId: string): Promise<unknown>; consume(userId: string): Promise<void> }
	now(): number
	log: { info(message: string): void; warn(message: string): void }
}

type Result<T> = DesktopSyncResult<T>

export interface SyncService {
	nativeEvent(message: NativeEvent, userId: string): Promise<void>
	hostChanged(state: DesktopSyncHostState): void
	signedOut(): void
	subscribe(page: Page, on: boolean): void
	// The page navigated or closed: it stops listening and its plans are released.
	pageGone(pageId: number): void
	overview(): Promise<DesktopSyncOverview>
	activity(pairId: string, limit: number): DesktopSyncActivity[]
	chooseLocalDirectory(): Promise<DesktopSyncLocalRootChoice>
	addPair(page: Page, pair: DesktopSyncNewPair): Promise<Result<{ pairId: string; plan: DesktopSyncPlan | null }>>
	startPair(pairId: string): Promise<Result<null>>
	removePair(pairId: string): Promise<Result<null>>
	pausePair(pairId: string): Promise<Result<null>>
	resumePair(pairId: string): Promise<Result<null>>
	setMode(pairId: string, mode: DesktopSyncMode, backlog: DesktopSyncBacklog | null): Promise<Result<null>>
	renamePair(pairId: string, name: string): Promise<Result<null>>
	syncNow(pairId: string): Promise<Result<null>>
	plan(page: Page, pairId: string): Promise<Result<DesktopSyncPlan | null>>
	planPage(planId: string, list: DesktopSyncPlanList, offset: number, limit: number): Promise<Result<DesktopSyncPlanPage>>
	releasePlan(planId: string): Promise<void>
	conflicts(pairId: string, offset: number, limit: number): Promise<Result<DesktopSyncEntries<DesktopSyncConflict>>>
	resolveConflict(pairId: string, relPath: string, resolution: DesktopSyncResolution): Promise<Result<string | null>>
	heldDeletions(pairId: string): Promise<Result<DesktopSyncHeldDeletions>>
	approveDeletions(pairId: string, passToken: string): Promise<Result<null>>
	retryPath(pairId: string, relPath: string): Promise<Result<null>>
	ignoredPaths(pairId: string, offset: number, limit: number): Promise<Result<DesktopSyncEntries<DesktopSyncIgnored>>>
	userIgnore(): Promise<Result<DesktopSyncUserIgnore>>
	setUserIgnore(text: string): Promise<Result<null>>
	reveal(pairId: string, target: "root" | "quarantine"): Promise<Result<null>>
	dismissNotice(pairId: string, notice: DesktopSyncNotice): Promise<void>
	retryHost(): void
}

function fail(code: DesktopSyncErrorCode, message?: string): { ok: false; error: { code: DesktopSyncErrorCode; message?: string } } {
	return { ok: false, error: message === undefined ? { code } : { code, message } }
}

const DONE = { ok: true, value: null } as const

function isBackup(mode: DesktopSyncMode): boolean {
	return mode === "localBackup" || mode === "remoteBackup"
}

// Between the page and the native host: pair names, review and notices in the shell store, everything else through
// the engine. Paths reach the engine only from main's own dialog, by token.
export function createSyncService(deps: SyncServiceDeps): SyncService {
	const { supervisor } = deps
	const activityLog = createActivityLog()
	const pages = new Map<number, Page>()
	// The page each plan was made for.
	const plans = new Map<string, number>()
	let host = supervisor.state()
	let runtime: readonly NativePairRuntime[] = []
	// The user the runtime and activity belong to.
	let hostUser: string | null = null
	// What each `ready` does to the pairs runs one at a time.
	const readyWork = serialQueue()

	async function overview(): Promise<DesktopSyncOverview> {
		const user = await supervisor.user()

		if (user === null) {
			return { host, pairs: [] }
		}

		const store = await deps.storeFor(user.userId)

		return mergeOverview(host, user.userId === hostUser ? runtime : [], store.get().pairs)
	}

	const schedulePush = pushThrottle(
		() => {
			void overview().then(current => {
				for (const page of pages.values()) {
					page.send(CHANNELS.syncOverview, current)
				}
			})
		},
		OVERVIEW_PUSH_INTERVAL_MS,
		deps.now,
		() => pages.size > 0
	)

	async function currentStore(): Promise<SyncStore | null> {
		const user = await supervisor.user()

		return user === null ? null : deps.storeFor(user.userId)
	}

	async function updatePairs(store: SyncStore, change: (pairs: ShellPair[]) => ShellPair[]): Promise<void> {
		await store.update(state => ({ ...state, pairs: change(state.pairs) }))
		schedulePush()
	}

	// The stored pair the page means.
	async function find(pairId: string): Promise<{ store: SyncStore; pair: ShellPair } | null> {
		const store = await currentStore()
		const pair = store?.get().pairs.find(entry => shellPairId(entry) === pairId)

		return store === null || pair === undefined ? null : { store, pair }
	}

	// A stored pair the engine holds, with its engine id.
	async function findHeld(pairId: string): Promise<{ store: SyncStore; pair: ShellPair; engineId: string } | null> {
		const found = await find(pairId)

		return found === null || found.pair.pairId === null ? null : { ...found, engineId: found.pair.pairId }
	}

	// A pair the engine holds, by its engine id.
	async function engineCall<K extends SyncOp>(
		pairId: string,
		op: K,
		args: (enginePairId: string) => NativeOpArgs<K>
	): Promise<NativeResult<K>> {
		const found = await findHeld(pairId)

		return found === null ? fail("pairNotFound") : supervisor.call(op, args(found.engineId))
	}

	function patchPair(store: SyncStore, pairId: string, patch: Partial<ShellPair>): Promise<void> {
		return updatePairs(store, pairs => pairs.map(pair => (shellPairId(pair) === pairId ? { ...pair, ...patch } : pair)))
	}

	async function rootContext(userId: string, store: SyncStore): Promise<LocalRootContext> {
		return {
			...deps.dialogs.rootContext(),
			pairRoots: store.get().pairs.map(pair => pair.localRoot),
			mountPoints: await deps.dialogs.mountPoints(userId)
		}
	}

	async function evaluate(page: Page, pairId: string): Promise<Result<DesktopSyncPlan | null>> {
		const evaluated = await supervisor.call("evaluatePlan", { pairId })

		if (!evaluated.ok) {
			return evaluated
		}

		if (evaluated.value.status === "unconverged") {
			return { ok: true, value: null }
		}

		const { planId, summary } = evaluated.value
		const { passToken: _passToken, ...shown } = summary

		plans.set(planId, page.id)

		return { ok: true, value: { planId, summary: shown } }
	}

	async function resume(pairId: string): Promise<Result<null>> {
		const found = await findHeld(pairId)

		if (found === null) {
			return fail("pairNotFound")
		}

		const resumed = await supervisor.call("resume", { pairId: found.engineId })

		if (!resumed.ok) {
			return resumed
		}

		await patchPair(found.store, pairId, { paused: false, state: "active", review: null })

		return DONE
	}

	// After the engine's pairs replaced the mirror's: pairs in review stay paused, the old client's pairs are imported
	// once, and every pair the engine does not hold is added through the first-run guard. Each step is retried on the
	// next `ready` when it fails.
	async function afterReady(userId: string, store: SyncStore): Promise<void> {
		const user = await supervisor.user()

		if (user?.userId !== userId) {
			return
		}

		const run: FirstRunDeps = {
			call: (op, args) => supervisor.call(op, args, userId),
			store: {
				...store,
				update: async change => {
					const next = await store.update(change)

					schedulePush()

					return next
				}
			},
			now: deps.now,
			log: deps.log
		}
		const steps: [string, () => Promise<void>][] = [
			["holding pairs in review", () => holdReviewed(run)],
			[
				"importing the previous app's pairs",
				() =>
					applyLegacySync({
						...run,
						rootUuid: user.rootUuid,
						stash: { pending: () => deps.legacySync.pending(userId), consume: () => deps.legacySync.consume(userId) }
					})
			],
			["adding pairs", () => attachUnheld(run)]
		]

		for (const [what, step] of steps) {
			try {
				await step()
			} catch (error) {
				deps.log.warn(`sync: ${what} failed: ${errorCode(error)}`)
			}
		}
	}

	function release(planId: string): void {
		plans.delete(planId)

		// A stopped host took its plans with it.
		if (supervisor.state().state === "running") {
			void supervisor.call("releasePlan", { planId })
		}
	}

	return {
		nativeEvent: async (message, userId) => {
			if (userId !== hostUser) {
				hostUser = userId
				runtime = []
				activityLog.clear()
			}

			switch (message.t) {
				case "ready":
					return readyWork(async () => {
						const store = await deps.storeFor(userId)
						let lost = 0

						await store.update(state => {
							const { pairs, readd } = reconcileMirror(state.pairs, message.pairs, { reset: message.reset, now: deps.now() })

							lost = readd.length

							return JSON.stringify(pairs) === JSON.stringify(state.pairs) ? state : { ...state, pairs }
						})
						schedulePush()

						if (lost > 0) {
							deps.log.info(`sync: re-adding ${String(lost)} pairs the engine lost`)
						}

						await afterReady(userId, store)
					})
				case "overview":
					runtime = message.pairs
					schedulePush()

					return
				case "activity": {
					const entries = activityLog.append(message.entries)

					for (const page of pages.values()) {
						page.send(CHANNELS.syncActivity, entries)
					}

					return
				}
				case "aggregate":
					return
			}
		},
		hostChanged: state => {
			host = state

			if (state.state !== "running") {
				runtime = []
				plans.clear()
			}

			schedulePush()
		},
		signedOut: () => {
			hostUser = null
			runtime = []
			plans.clear()
			activityLog.clear()
			schedulePush()
		},
		subscribe: (page, on) => {
			if (on) {
				pages.set(page.id, page)
				void overview().then(current => {
					page.send(CHANNELS.syncOverview, current)
				})
			} else {
				pages.delete(page.id)
			}

			supervisor.subscribe(pages.size > 0)
		},
		pageGone: pageId => {
			if (pages.delete(pageId)) {
				supervisor.subscribe(pages.size > 0)
			}

			for (const [planId, owner] of plans) {
				if (owner === pageId) {
					release(planId)
				}
			}
		},
		overview,
		activity: (pairId, limit) => activityLog.list(pairId, limit),
		chooseLocalDirectory: async () => {
			const user = await supervisor.user()

			if (user === null) {
				return { status: "canceled" }
			}

			const store = await deps.storeFor(user.userId)

			return chooseLocalDirectory(deps.dialogs.showOpenDialog, () => rootContext(user.userId, store), deps.tokens)
		},
		addPair: async (page, { localRootId, remoteRoot, mode, name }) => {
			const chosen = deps.tokens.take(localRootId)

			if (chosen === null) {
				return fail("rootExpired")
			}

			const user = await supervisor.user()

			if (user === null) {
				return fail("hostUnavailable")
			}

			if (remoteRoot.toLowerCase() === user.rootUuid.toLowerCase()) {
				return fail("accountRoot")
			}

			const store = await deps.storeFor(user.userId)
			// The directory may have changed since it was chosen.
			const inspected = await inspectLocalRoot(chosen, await rootContext(user.userId, store))

			if (inspected.problem !== null) {
				return fail("rootRefused", inspected.problem)
			}

			const added = await supervisor.call("addPair", { localRoot: inspected.path, remoteRoot, mode })

			if (!added.ok) {
				return added
			}

			const { pairId } = added.value
			// Paused until the page has shown the dry run and the user started it; unpausable or unplannable is no pair.
			const paused = await supervisor.call("pause", { pairId })
			const plan = paused.ok ? await evaluate(page, pairId) : paused

			if (!plan.ok) {
				await supervisor.call("removePair", { pairId })

				return plan
			}

			await updatePairs(store, pairs => [
				...pairs.filter(pair => pair.pairId !== pairId),
				{
					pairId,
					name: name.trim(),
					localRoot: inspected.path,
					remoteRoot,
					mode,
					paused: true,
					state: "active",
					review: null,
					legacyUuid: null,
					legacyDotFiles: null,
					notices: [],
					createdAt: deps.now()
				}
			])

			return { ok: true, value: { pairId, plan: plan.value } }
		},
		startPair: resume,
		resumePair: resume,
		removePair: async pairId => {
			const found = await find(pairId)

			if (found === null) {
				return fail("pairNotFound")
			}

			if (found.pair.pairId !== null) {
				const removed = await supervisor.call("removePair", { pairId: found.pair.pairId })

				if (!removed.ok && removed.error.code !== "pairNotFound") {
					return removed
				}
			}

			await updatePairs(found.store, pairs => pairs.filter(pair => shellPairId(pair) !== pairId))
			activityLog.drop(pairId)
			supervisor.ensure("pair removed")

			return DONE
		},
		pausePair: async pairId => {
			const found = await findHeld(pairId)

			if (found === null) {
				return fail("pairNotFound")
			}

			const paused = await supervisor.call("pause", { pairId: found.engineId })

			if (!paused.ok) {
				return paused
			}

			await patchPair(found.store, pairId, { paused: true })

			return DONE
		},
		setMode: async (pairId, mode, backlog) => {
			const found = await findHeld(pairId)

			if (found === null) {
				return fail("pairNotFound")
			}

			const leavingBackup = isBackup(found.pair.mode) && mode !== found.pair.mode

			// What the backup kept from the destination must be decided, never defaulted.
			if (leavingBackup && backlog === null) {
				return fail("modeConflict")
			}

			const changed = await supervisor.call("setMode", {
				pairId: found.engineId,
				mode,
				backlog: leavingBackup ? backlog : null
			})

			if (!changed.ok) {
				return changed
			}

			await patchPair(found.store, pairId, { mode })

			const pass = await supervisor.call("requestPass", { pairId: found.engineId })

			return pass.ok ? DONE : pass
		},
		renamePair: async (pairId, name) => {
			const found = await find(pairId)

			if (found === null) {
				return fail("pairNotFound")
			}

			await patchPair(found.store, pairId, { name: name.trim() })

			return DONE
		},
		syncNow: pairId => engineCall(pairId, "requestPass", id => ({ pairId: id })),
		plan: async (page, pairId) => {
			const found = await findHeld(pairId)

			return found === null ? fail("pairNotFound") : evaluate(page, found.engineId)
		},
		planPage: (planId, list, offset, limit) => supervisor.call("planPage", { planId, list, offset, limit }),
		releasePlan: async planId => {
			if (plans.has(planId)) {
				release(planId)
			}
		},
		conflicts: (pairId, offset, limit) => engineCall(pairId, "conflicts", id => ({ pairId: id, offset, limit })),
		resolveConflict: (pairId, relPath, resolution) =>
			engineCall(pairId, "resolveConflict", id => ({ pairId: id, relPath, resolution })),
		heldDeletions: pairId => engineCall(pairId, "heldDeletions", id => ({ pairId: id })),
		approveDeletions: (pairId, passToken) => engineCall(pairId, "approveDeletions", id => ({ pairId: id, passToken })),
		retryPath: (pairId, relPath) => engineCall(pairId, "retryPath", id => ({ pairId: id, relPath })),
		ignoredPaths: (pairId, offset, limit) => engineCall(pairId, "ignoredPaths", id => ({ pairId: id, offset, limit })),
		userIgnore: async () => {
			const [text, defaults] = await Promise.all([supervisor.call("userIgnore", {}), supervisor.call("defaultIgnore", {})])

			if (!text.ok) {
				return text
			}

			return defaults.ok ? { ok: true, value: { text: text.value, defaults: defaults.value } } : defaults
		},
		setUserIgnore: text => supervisor.call("setUserIgnore", { text }),
		reveal: async (pairId, target) => {
			const found = await find(pairId)

			if (found === null) {
				return fail("pairNotFound")
			}

			const directory = target === "root" ? found.pair.localRoot : path.join(found.pair.localRoot, QUARANTINE_DIR)

			// openPath answers with an error message, "" on success.
			return (await deps.shell.openPath(directory)) === "" ? DONE : fail("localRootMissing")
		},
		dismissNotice: async (pairId, notice) => {
			const found = await find(pairId)

			if (found === null || !found.pair.notices.includes(notice)) {
				return
			}

			// A pair kept only to tell the user the engine refused it goes with its notice.
			if (isRefusedNotice(notice)) {
				await updatePairs(found.store, pairs => pairs.filter(pair => shellPairId(pair) !== pairId))
				activityLog.drop(pairId)
				supervisor.ensure("pair removed")
			} else {
				await patchPair(found.store, pairId, { notices: found.pair.notices.filter(entry => entry !== notice) })
			}
		},
		retryHost: () => {
			supervisor.retry()
		}
	}
}
