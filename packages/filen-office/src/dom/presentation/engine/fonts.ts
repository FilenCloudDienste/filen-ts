import { PresentationError } from "../../../core/presentation/model"
import type { FontsCapability } from "../engine"

// Not built yet: the faces are refused as notImplemented.
export const fontsCapability: FontsCapability = {
	faces: () => Promise.reject(new PresentationError("notImplemented", "fonts"))
}
