import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the transition family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxTransition: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit transition")
}
