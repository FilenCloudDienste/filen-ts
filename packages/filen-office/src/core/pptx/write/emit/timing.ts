import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the timing family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxTiming: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit timing")
}
