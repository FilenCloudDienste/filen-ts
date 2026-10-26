import { PresentationError } from "../../../core/presentation/model"
import type { ConvertCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const convertCapability: ConvertCapability = {
	freshParts: () => Promise.reject(new PresentationError("notImplemented", "freshParts"))
}
