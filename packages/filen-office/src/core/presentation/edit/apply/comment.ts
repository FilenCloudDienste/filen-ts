import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { CommentOp } from "../ops"

// Applies the comment ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyComment: ApplyFamily<CommentOp> = {
	apply: () => refused("notImplemented", "apply comment"),
	touches: () => []
}
