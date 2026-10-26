import { PresentationError } from "../../../core/presentation/model"
import type { ShowCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const showCapability: ShowCapability = {
	timegraph: () => Promise.reject(new PresentationError("notImplemented", "timegraph")),
	layers: () => Promise.reject(new PresentationError("notImplemented", "layers"))
}
