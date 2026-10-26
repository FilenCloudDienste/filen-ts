import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { PictureOp } from "../ops"

// Applies the picture ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyPicture: ApplyFamily<PictureOp> = {
	apply: () => refused("notImplemented", "apply picture"),
	touches: () => []
}
