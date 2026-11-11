import { type } from "arktype"
import { CHANNELS, type DragCall, dragChannel } from "../../shared/channels.ts"
import { type CheckedCall, checkedCalls, type IpcMain, pageOf, registerCalls } from "../pages.ts"
import { downloadItemsSchema } from "../transfers/ipc.ts"
import { DRAG_IMAGE_MAX_BYTES, DRAG_IMAGE_MAX_HEIGHT, DRAG_IMAGE_MAX_SCALE, DRAG_IMAGE_MAX_WIDTH, dragImageFits } from "./image.ts"
import type { DragOutService } from "./service.ts"

// Checked against DesktopDragImage where the service takes it (the cloned Uint8Array has its own ArrayBuffer).
const imageSchema = type({
	png: type.instanceOf(Uint8Array).narrow((png, ctx) => png.byteLength <= DRAG_IMAGE_MAX_BYTES || ctx.mustBe("a PNG of at most 2 MiB")),
	width: type.number.moreThan(0).atMost(DRAG_IMAGE_MAX_WIDTH),
	height: type.number.moreThan(0).atMost(DRAG_IMAGE_MAX_HEIGHT),
	scale: type.number.moreThan(0).atMost(DRAG_IMAGE_MAX_SCALE),
	"+": "reject"
}).narrow((image, ctx) => dragImageFits(image) || ctx.mustBe("a PNG no larger than its size"))

// Ids are the service's own (randomUUID); which sender may use one, the sessions decide.
const idSchema = type("string.uuid")

const call = checkedCalls<DragOutService>("drag")

const CALLS: Record<DragCall, CheckedCall<DragOutService>> = {
	prepare: call(type([{ items: downloadItemsSchema, "+": "reject" }]), (service, page, [request]) =>
		service.prepare(page, request.items)
	),
	begin: call(type([{ id: idSchema, image: imageSchema, "+": "reject" }]), (service, page, [request]) =>
		service.begin(page, request.id, request.image)
	),
	release: call(type([idSchema]), (service, page, [id]) => {
		service.release(page, id)
	})
}

// Every drag request answers the app's own top-level document only, with arguments checked before the service sees
// them. A page sends drive items and the drag image, never a local path.
export function registerDragOutIpc(ipc: IpcMain, service: DragOutService, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, dragChannel, service, trusted)

	ipc.on(CHANNELS.dragSubscribe, (event, on) => {
		if (trusted(event.senderFrame?.url) && typeof on === "boolean") {
			service.subscribe(pageOf(event.sender), on)
		}
	})
}
