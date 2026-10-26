import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { MediaTimingOp } from "../ops"

// Applies the mediaTiming ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyMediaTiming: ApplyFamily<MediaTimingOp> = {
	apply: () => refused("notImplemented", "apply mediaTiming"),
	touches: () => []
}
