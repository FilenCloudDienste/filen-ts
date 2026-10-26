import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { MediaOp } from "../ops"

// Applies the media ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyMedia: ApplyFamily<MediaOp> = {
	apply: () => refused("notImplemented", "apply media"),
	touches: () => []
}
