import { PresentationError } from "../../../core/presentation/model"
import type { EditCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const editCapability: EditCapability = {
	command: () => Promise.reject(new PresentationError("notImplemented", "command")),
	undo: () => Promise.reject(new PresentationError("notImplemented", "undo")),
	redo: () => Promise.reject(new PresentationError("notImplemented", "redo"))
}
