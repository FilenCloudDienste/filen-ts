import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { SlideOp } from "../ops"

// Applies the slide ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applySlide: ApplyFamily<SlideOp> = {
	apply: () => refused("notImplemented", "apply slide"),
	touches: () => []
}
