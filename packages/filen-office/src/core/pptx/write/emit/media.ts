import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the media family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxMedia: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit media")
}
