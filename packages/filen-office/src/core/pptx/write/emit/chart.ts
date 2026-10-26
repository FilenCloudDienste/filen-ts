import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the chart family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxChart: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit chart")
}
