import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { ShapeOp } from "../ops"

// Applies the shape ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyShape: ApplyFamily<ShapeOp> = {
	apply: () => refused("notImplemented", "apply shape"),
	touches: () => []
}
