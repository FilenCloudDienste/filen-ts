import { PresentationError } from "../../../core/presentation/model"
import type { ViewCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const viewCapability: ViewCapability = {
	render: () => Promise.reject(new PresentationError("notImplemented", "render")),
	image: () => Promise.reject(new PresentationError("notImplemented", "image"))
}
