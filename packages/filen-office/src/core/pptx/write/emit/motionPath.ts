import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the motionPath family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxMotionPath: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit motionPath")
}
