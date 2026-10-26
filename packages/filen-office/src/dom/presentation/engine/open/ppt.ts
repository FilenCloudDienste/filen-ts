import { refused } from "../../../../core/presentation/model"
import type { OpenCapability } from "../../engine"

// Opens a ppt deck into a session. Not built yet: refused as notImplemented.
export const openPptCapability: OpenCapability = {
	open: () => Promise.resolve(refused("notImplemented", "open ppt"))
}
