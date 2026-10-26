import { refused } from "../../../core/presentation/model"
import type { JobDefinition } from "./registry"

// PDF of slides, notes pages or handouts. Not built yet: refused as notImplemented.
export const pdfJob: JobDefinition<"pdf"> = {
	run: () => Promise.resolve(refused("notImplemented", "pdf job"))
}
