import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the ink family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxInk: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit ink")
}
