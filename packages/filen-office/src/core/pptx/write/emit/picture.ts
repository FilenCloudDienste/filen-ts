import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the picture family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxPicture: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit picture")
}
