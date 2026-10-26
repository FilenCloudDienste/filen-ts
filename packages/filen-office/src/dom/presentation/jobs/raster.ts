import { refused } from "../../../core/presentation/model"
import type { JobDefinition } from "./registry"

// PNG or JPEG images of slides. Not built yet: refused as notImplemented.
export const rasterJob: JobDefinition<"raster"> = {
	run: () => Promise.resolve(refused("notImplemented", "raster job"))
}
