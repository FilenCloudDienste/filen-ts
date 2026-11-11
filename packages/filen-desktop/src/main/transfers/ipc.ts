import { type } from "arktype"
import type { DesktopDownloadItem, DesktopTransferKind, DesktopUploadParent } from "@filen/shared/desktop"
import { CHANNELS, TRANSFER_ITEMS_MAX, type TransfersCall, transfersChannel } from "../../shared/channels.ts"
import { absolutePathSchema, countSchema, pinned, sdkRefSchema, sdkValuesFit, transferIdSchema } from "../../shared/nativeProtocol.ts"
import { type CheckedCall, checkedCalls, type IpcMain, pageOf, registerCalls } from "../pages.ts"
import type { TransfersService } from "./service.ts"

// What one call may carry, as the host's own limits: TRANSFER_ITEMS_MAX items, SDK values of 16 MiB together.
const kindSchema = pinned<DesktopTransferKind>()(type("'file' | 'directory'"))

const itemSchema = pinned<DesktopDownloadItem>()(
	type({ kind: kindSchema, ref: sdkRefSchema, name: "0 < string <= 1024", size: countSchema, "+": "reject" })
)

// Also what a drag-out prepare carries.
export const downloadItemsSchema = itemSchema
	.array()
	.moreThanLength(0)
	.atMostLength(TRANSFER_ITEMS_MAX)
	.narrow((items, ctx) => sdkValuesFit(items, item => item.ref.value.length) || ctx.mustBe("SDK values of at most 16 MiB together"))

const parentSchema = pinned<DesktopUploadParent>()(type({ uuid: "string.uuid", ref: sdkRefSchema, "+": "reject" }))

const idsSchema = transferIdSchema.array().moreThanLength(0).atMostLength(TRANSFER_ITEMS_MAX)

const call = checkedCalls<TransfersService>("transfers")

const CALLS: Record<TransfersCall, CheckedCall<TransfersService>> = {
	download: call(
		type([downloadItemsSchema]).or([downloadItemsSchema, type({ "ask?": "boolean", "+": "reject" })]),
		(service, _page, [items, options]) =>
			service.startDownload({
				items,
				destination: options?.ask === true ? { kind: "prefs", ask: true } : { kind: "prefs" },
				origin: "page",
				revealable: true
			})
	),
	upload: call(
		type([absolutePathSchema.array().moreThanLength(0).atMostLength(TRANSFER_ITEMS_MAX), parentSchema]),
		(service, _page, [paths, parent]) => service.startUpload({ paths, parent, origin: "page" })
	),
	pickUpload: call(type([kindSchema, parentSchema]), (service, _page, [kind, parent]) => service.pickUpload(kind, parent)),
	cancel: call(type([idsSchema]), (service, _page, [ids]) => {
		service.cancel(ids)
	}),
	setPaused: call(type([idsSchema, "boolean"]), (service, _page, [ids, paused]) => {
		service.setPaused(ids, paused)
	}),
	reveal: call(type([transferIdSchema]), (service, _page, [id]) => service.reveal(id)),
	open: call(type([transferIdSchema]), (service, _page, [id]) => service.open(id)),
	chooseDownloadDirectory: call(type([]), service => service.chooseDownloadDirectory())
}

// Every transfers request answers the app's own top-level document only, with arguments checked before the service
// sees them. Paths a page sends are only ever read (uploads); where downloads go only main's dialogs and the stored
// pref decide.
export function registerTransfersIpc(ipc: IpcMain, service: TransfersService, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, transfersChannel, service, trusted)

	ipc.on(CHANNELS.transfersSubscribe, (event, on) => {
		if (trusted(event.senderFrame?.url) && typeof on === "boolean") {
			service.subscribe(pageOf(event.sender), on)
		}
	})
}
