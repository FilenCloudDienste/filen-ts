import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { TimingOp } from "../ops"

// Applies the timing ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyTiming: ApplyFamily<TimingOp> = {
	apply: () => refused("notImplemented", "apply timing"),
	touches: () => []
}
