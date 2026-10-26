import { PresentationError } from "../../../core/presentation/model"
import type { TextCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const textCapability: TextCapability = {
	textSeed: () => Promise.reject(new PresentationError("notImplemented", "textSeed")),
	layoutText: () => Promise.reject(new PresentationError("notImplemented", "layoutText"))
}
