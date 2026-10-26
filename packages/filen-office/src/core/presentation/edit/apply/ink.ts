import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { InkOp } from "../ops"

// Applies the ink ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyInk: ApplyFamily<InkOp> = {
	apply: () => refused("notImplemented", "apply ink"),
	touches: () => []
}
