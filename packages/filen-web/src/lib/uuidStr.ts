import type { UuidStr } from "@filen/sdk-rs"
import { isUuid } from "@filen/shared"

// Narrows a string to the SDK's UuidStr after the strict uuid check.
export function isUuidStr(value: string): value is UuidStr {
	return isUuid(value)
}
