import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the design family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxDesign: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit design")
}
