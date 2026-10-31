import { type } from "arktype"
import { CHANNELS, type SyncCall, syncChannel } from "../../shared/channels.ts"
import {
	countSchema,
	ignoreTextSchema,
	passTokenSchema,
	planIdSchema,
	planListSchema,
	relPathArgSchema,
	syncModeSchema
} from "../../shared/nativeProtocol.ts"
import { type CheckedCall, checkedCalls, type IpcMain, pageOf, registerCalls } from "../pages.ts"
import type { SyncService } from "./service.ts"
import { infoNoticeSchema, noticeSchema } from "./store.ts"

// DesktopSyncPair.id: the engine's id, or the stand-in of a pair the engine does not hold (mirror.ts shellPairId).
const pairIdSchema = type(/^(?:0|[1-9]\d{0,19}|(?:legacy|remote):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
// A page shows at most this many entries at once.
const limitSchema = type("1 <= number.integer <= 200")
// localRoot.ts createRootTokens: 128 bits as hex.
export const rootIdSchema = type(/^[0-9a-f]{32}$/)
const nameSchema = type("0 < string <= 1024").narrow(name => name.trim().length > 0)
const newPairSchema = type({
	localRootId: rootIdSchema,
	remoteRoot: "string.uuid",
	mode: syncModeSchema,
	name: nameSchema,
	"+": "reject"
})

const call = checkedCalls<SyncService>("sync")

const one = type([pairIdSchema])

const CALLS: Record<SyncCall, CheckedCall<SyncService>> = {
	overview: call(type([]), service => service.overview()),
	activity: call(type([pairIdSchema, limitSchema]), (service, _page, [pairId, limit]) => service.activity(pairId, limit)),
	chooseLocalDirectory: call(type([]), service => service.chooseLocalDirectory()),
	addPair: call(type([newPairSchema]), (service, page, [pair]) => service.addPair(page, pair)),
	startPair: call(one, (service, _page, [pairId]) => service.startPair(pairId)),
	removePair: call(one, (service, _page, [pairId]) => service.removePair(pairId)),
	pausePair: call(one, (service, _page, [pairId]) => service.pausePair(pairId)),
	resumePair: call(one, (service, _page, [pairId]) => service.resumePair(pairId)),
	setMode: call(type([pairIdSchema, syncModeSchema, type("'propagate' | 'adoptDestination' | null")]), (service, _page, args) =>
		service.setMode(...args)
	),
	renamePair: call(type([pairIdSchema, nameSchema]), (service, _page, [pairId, name]) => service.renamePair(pairId, name)),
	syncNow: call(one, (service, _page, [pairId]) => service.syncNow(pairId)),
	plan: call(one, (service, page, [pairId]) => service.plan(page, pairId)),
	planPage: call(type([planIdSchema, planListSchema, countSchema, limitSchema]), (service, _page, args) => service.planPage(...args)),
	releasePlan: call(type([planIdSchema]), (service, _page, [planId]) => service.releasePlan(planId)),
	conflicts: call(type([pairIdSchema, countSchema, limitSchema]), (service, _page, args) => service.conflicts(...args)),
	resolveConflict: call(type([pairIdSchema, relPathArgSchema, type("'keepLocal' | 'keepRemote' | 'keepBoth'")]), (service, _page, args) =>
		service.resolveConflict(...args)
	),
	heldDeletions: call(one, (service, _page, [pairId]) => service.heldDeletions(pairId)),
	approveDeletions: call(type([pairIdSchema, passTokenSchema]), (service, _page, args) => service.approveDeletions(...args)),
	retryPath: call(type([pairIdSchema, relPathArgSchema]), (service, _page, args) => service.retryPath(...args)),
	retryAll: call(one, (service, _page, [pairId]) => service.retryAll(pairId)),
	unsyncablePaths: call(type([pairIdSchema, countSchema, limitSchema]), (service, _page, args) => service.unsyncablePaths(...args)),
	ignoredPaths: call(type([pairIdSchema, countSchema, limitSchema]), (service, _page, args) => service.ignoredPaths(...args)),
	userIgnore: call(type([]), service => service.userIgnore()),
	setUserIgnore: call(type([ignoreTextSchema]), (service, _page, [text]) => service.setUserIgnore(text)),
	reveal: call(type([pairIdSchema, type("'root' | 'bin'")]), (service, _page, args) => service.reveal(...args)),
	dismissNotice: call(type([pairIdSchema, noticeSchema]), (service, _page, args) => service.dismissNotice(...args)),
	holdAction: call(type([pairIdSchema, type("'retry' | 'startAnyway'")]), (service, _page, args) => service.holdAction(...args)),
	dismissInfo: call(type([pairIdSchema, infoNoticeSchema]), (service, _page, args) => service.dismissInfo(...args)),
	dismissImportNote: call(type([]), service => service.dismissImportNote()),
	retryHost: call(type([]), service => {
		service.retryHost()
	})
}

const subscribeSchema = type("boolean")

// Every sync request answers the app's own top-level document only, with arguments checked before the service sees
// them. Local paths are never among them: a root travels as the id chooseLocalDirectory issued.
export function registerSyncIpc(ipc: IpcMain, service: SyncService, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, syncChannel, service, trusted)

	ipc.on(CHANNELS.syncSubscribe, (event, on) => {
		const valid = subscribeSchema(on)

		if (trusted(event.senderFrame?.url) && !(valid instanceof type.errors)) {
			service.subscribe(pageOf(event.sender), valid)
		}
	})
}
