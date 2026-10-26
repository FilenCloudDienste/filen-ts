import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { ChartOp } from "../ops"

// Applies the chart ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyChart: ApplyFamily<ChartOp> = {
	apply: () => refused("notImplemented", "apply chart"),
	touches: () => []
}
