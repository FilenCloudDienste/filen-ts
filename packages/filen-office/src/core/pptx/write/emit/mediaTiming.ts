import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the mediaTiming family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxMediaTiming: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit mediaTiming")
}
