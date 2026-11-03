import { refused } from "../../../presentation/model"
import type { OdpEmitFamily } from "../emit"
import { emitOdpMedia } from "./media"

// A medium in ODF (the media family's draw:frame with its draw:plugin): ODF has no trim, fade or bookmarks of a medium
// (a plugin's draw:param names are its application's), so an OpenDocument deck holds none (the reader gives none and
// apply refuses them) and a conversion counts each one it cannot carry (odp/write/fresh.ts, mediaTimingLosses).
export const emitOdpMediaTiming: OdpEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape?.media === undefined && shape?.frame?.kind !== "media") return refused("failed", "A media timing emit without a medium")

		return emitOdpMedia.emit(request, context)
	}
}
