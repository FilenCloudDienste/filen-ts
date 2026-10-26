import { PresentationError } from "../../../core/presentation/model"
import type { MediaCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const mediaCapability: MediaCapability = {
	media: () => Promise.reject(new PresentationError("notImplemented", "media"))
}
