import type { PptxEmitFamily } from "../types"
import { emitPptxShape } from "./shape"

// The ink family's PresentationML. Kept ink is a p:grpSp of p:sp freeforms (a:custGeom through the points, a:noFill,
// a round-capped a:ln) and an ink content part (p:contentPart) is a shape element whose box alone an edit rewrites:
// both are the shape family's markup, so this writes nothing of its own and no markup is held twice.
export const emitPptxInk: PptxEmitFamily = {
	emit: (request, context) => emitPptxShape.emit(request, context)
}
