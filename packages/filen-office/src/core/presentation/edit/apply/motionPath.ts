import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { MotionPathOp } from "../ops"

// Applies the motionPath ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyMotionPath: ApplyFamily<MotionPathOp> = {
	apply: () => refused("notImplemented", "apply motionPath"),
	touches: () => []
}
