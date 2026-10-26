import { refused } from "../../../../core/presentation/model"
import type { OpenCapability } from "../../engine"

// Opens a pptx deck into a session. Not built yet: refused as notImplemented.
export const openPptxCapability: OpenCapability = {
	open: () => Promise.resolve(refused("notImplemented", "open pptx"))
}
