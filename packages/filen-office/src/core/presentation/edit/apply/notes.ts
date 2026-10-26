import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { NotesOp } from "../ops"

// Applies the notes ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyNotes: ApplyFamily<NotesOp> = {
	apply: () => refused("notImplemented", "apply notes"),
	touches: () => []
}
