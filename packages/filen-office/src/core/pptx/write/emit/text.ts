import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the text family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxText: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit text")
}
