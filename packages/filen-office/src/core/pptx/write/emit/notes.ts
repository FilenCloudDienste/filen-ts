import { refused } from "../../../presentation/model"
import type { PptxEmitFamily } from "../types"

// Writes the notes family's elements as PresentationML. Not built yet: every emit is refused as notImplemented.
export const emitPptxNotes: PptxEmitFamily = {
	emit: () => refused("notImplemented", "pptx emit notes")
}
