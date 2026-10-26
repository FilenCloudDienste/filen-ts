import { refused } from "../../model"
import type { ApplyFamily } from "../apply"
import type { TableOp } from "../ops"

// Applies the table ops to the model. Not built yet: every op is refused as notImplemented and touches nothing.
export const applyTable: ApplyFamily<TableOp> = {
	apply: () => refused("notImplemented", "apply table"),
	touches: () => []
}
