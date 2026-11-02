import type { OdpEmitFamily } from "../emit"
import { emitOdpTiming } from "./timing"

// A motion path lives in its page's timing root (ODF 1.3 anim:animateMotion svg:path, SVG path data in fractions of
// the page relative to the shape), so its markup is the timing family's: core/anim/odf.ts writes the edited
// anim:animateMotion with the path as SVG path data (the §19.5.4 E end mark dropped) and keeps every other node of
// the page's timing as its source span.
export const emitOdpMotionPath: OdpEmitFamily = {
	emit: (request, context) => emitOdpTiming.emit(request, context)
}
