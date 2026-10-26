import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { DesignOp } from "../ops"

// Applies the design ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyDesign: ApplyFamily<DesignOp> = {
	apply: () => refused("notImplemented", "apply design"),
	touches: () => []
}
