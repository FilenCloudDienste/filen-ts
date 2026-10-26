import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the shape family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxShape: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit shape")
}
