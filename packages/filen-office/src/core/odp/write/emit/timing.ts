import { odpTimingMarkup, readOdpTiming } from "../../../anim/odf"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../../presentation/budget"
import { Namespaces } from "../../../xml/index"
import { Fragment } from "../../read/context"
import type { OdpEmitFamily } from "../emit"

// The timing family's ODF markup: the page's timing root (anim:par presentation:node-type="timing-root") out of the
// slide's TimingTree, through core/anim/odf.ts. The page fragment's own timing is read again as the pristine tree, so
// every node that did not change is its source span and the page transition par stays where it was; no pieces when
// the slide lost its timing. The ODP writer puts the element in place of the source root, or after the page's shapes.
export const emitOdpTiming: OdpEmitFamily = {
	emit: (request, context) => {
		const slide = request.slide
		const src = slide.timing?.src ?? slide.src
		const document = context.document
		const fragment =
			document === undefined || src?.format !== "odp"
				? undefined
				: new Fragment(document, new Namespaces(document, { lenient: true }), src.part, src.fragment, "content", src.epoch)
		const page = slide.src?.format === "odp" ? slide.src.node : -1
		const pristine =
			fragment === undefined || page < 0
				? undefined
				: readOdpTiming(fragment, page, slide.shapes, DEFAULT_PRESENTATION_BUDGETS.timing)

		return { kind: "markup", pieces: odpTimingMarkup({ fragment, shapes: slide.shapes }, slide.timing, pristine) }
	}
}
