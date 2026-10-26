import { PresentationError } from "../../../core/presentation/model"
import type { SmartArtCapability } from "../engine"

// Not built yet: relayouts and previews are refused as notImplemented (diagrams with a drawing cache still render as
// the cache).
export const smartartCapability: SmartArtCapability = {
	relayout: () => Promise.reject(new PresentationError("notImplemented", "smartart relayout")),
	preview: () => Promise.reject(new PresentationError("notImplemented", "smartart preview")),
	smartArtPreview: () => Promise.reject(new PresentationError("notImplemented", "smartArtPreview"))
}
