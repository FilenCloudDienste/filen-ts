// Standard RFC 4122 layout: 8-4-4-4-12 hex, version nibble 1-8, variant nibble
// [89ab]. The nil and max UUIDs are accepted as special cases. This mirrors the
// behavior of the `uuid` package's `validate()` exactly (verified across version
// and variant edge cases), so we can drop the direct `uuid` dependency — we only
// ever used `validate` for format checks.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

export function validateUuid(value: string): boolean {
	if (UUID_REGEX.test(value)) {
		return true
	}

	const lower = value.toLowerCase()

	return lower === NIL_UUID || lower === MAX_UUID
}
