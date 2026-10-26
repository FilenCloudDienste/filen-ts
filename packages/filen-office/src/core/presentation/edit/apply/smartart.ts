import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { SmartArtOp } from "../ops"

// Applies the smartart ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applySmartArt: ApplyFamily<SmartArtOp> = {
	apply: () => refused("notImplemented", "apply smartart"),
	touches: () => []
}
