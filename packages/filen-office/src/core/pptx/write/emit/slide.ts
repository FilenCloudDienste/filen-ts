import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the slide family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxSlide: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit slide")
}
