import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { TextOp } from "../ops"

// Applies the text ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyText: ApplyFamily<TextOp> = {
	apply: () => refused("notImplemented", "apply text"),
	touches: () => []
}
