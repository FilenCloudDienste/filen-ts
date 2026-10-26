import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the smartart family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxSmartArt: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit smartart")
}
