import { refused } from "../../../core/presentation/model"
import type { JobDefinition } from "./registry"

// A fresh package of the session in the other format. Not built yet: refused as notImplemented.
export const convertJob: JobDefinition<"convert"> = {
	run: () => Promise.resolve(refused("notImplemented", "convert job"))
}
