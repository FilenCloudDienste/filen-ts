import type { UuidStr } from "@filen/sdk-rs"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable label into it.
export function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}
