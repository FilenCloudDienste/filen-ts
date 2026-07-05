import { i18n } from "@/lib/i18n"
import { labelFirst, type ErrorDTO } from "@/lib/sdk/errors"

// Main-thread only — this is exactly why it is NOT part of lib/sdk/errors.ts (see that module's
// header comment: workers must stay i18n-free). `dto.kind` is a live runtime string, not a literal
// member of the "errors" namespace's typed key union, so even after `i18n.exists` confirms it at
// runtime, the typed `t()` can never statically prove the template-string key is valid. `as never`
// is the documented escape hatch for exactly this dynamic-key-under-a-typed-catalog gap — confine
// it to this one call site, never widen it elsewhere.
export function errorLabel(dto: ErrorDTO): string {
	if (dto.kind !== undefined && i18n.exists(`errors:${dto.kind}`)) {
		return i18n.t(`errors:${dto.kind}` as never)
	}

	return labelFirst(dto)
}
