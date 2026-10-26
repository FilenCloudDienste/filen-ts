import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the table family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxTable: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit table")
}
