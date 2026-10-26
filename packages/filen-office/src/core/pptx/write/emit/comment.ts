import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the comment family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxComment: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit comment")
}
