import { PresentationError } from "../../../core/presentation/model"
import type { ThumbsCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const thumbsCapability: ThumbsCapability = {
	thumbnails: () => Promise.reject(new PresentationError("notImplemented", "thumbnails"))
}
