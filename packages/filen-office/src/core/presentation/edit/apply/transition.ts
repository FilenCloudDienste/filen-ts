import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { TransitionOp } from "../ops"

// Applies the transition ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyTransition: ApplyFamily<TransitionOp> = {
	apply: () => refused("notImplemented", "apply transition"),
	touches: () => []
}
