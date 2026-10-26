import { PresentationError } from "../../../core/presentation/model"
import type { SaveCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const saveCapability: SaveCapability = {
	save: () => Promise.reject(new PresentationError("notImplemented", "save")),
	commitSaved: () => Promise.reject(new PresentationError("notImplemented", "commitSaved"))
}
