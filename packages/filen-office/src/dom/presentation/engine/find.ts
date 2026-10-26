import { PresentationError } from "../../../core/presentation/model"
import type { FindCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const findCapability: FindCapability = {
	find: () => Promise.reject(new PresentationError("notImplemented", "find"))
}
