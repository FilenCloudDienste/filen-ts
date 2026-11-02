import type { PptxEmitFamily } from "../types"
import { emitPptxTiming } from "./timing"

// A motion path lives in its slide's p:timing (ECMA-376 §19.5.4 p:animMotion path, ptsTypes, origin, pathEditMode,
// rAng), so its markup is the timing family's: the whole p:timing with every node the edit left alone as its source
// span and the edited animMotion written again with its unmodelled attributes and children copied from the source.
// The path value is written as apply set it (core/anim/motionEdit.ts writes custom paths slide-relative, five decimals,
// ended by E; preset paths keep their own text).
export const emitPptxMotionPath: PptxEmitFamily = {
	emit: (request, context) => emitPptxTiming.emit(request, context)
}
