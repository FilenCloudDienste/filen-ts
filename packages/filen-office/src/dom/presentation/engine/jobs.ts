import { PresentationError } from "../../../core/presentation/model"
import type { JobsCapability } from "../engine"

// Not built yet: every call is refused as notImplemented.
export const jobsCapability: JobsCapability = {
	jobsPort: () => Promise.reject(new PresentationError("notImplemented", "jobsPort"))
}
