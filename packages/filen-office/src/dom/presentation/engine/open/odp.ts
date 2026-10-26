import { refused } from "../../../../core/presentation/model"
import type { OpenCapability } from "../../engine"

// Opens a odp deck into a session. Not built yet: refused as notImplemented.
export const openOdpCapability: OpenCapability = {
	open: () => Promise.resolve(refused("notImplemented", "open odp"))
}
