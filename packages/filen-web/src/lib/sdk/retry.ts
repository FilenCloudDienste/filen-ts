import { asErrorDTO } from "@/lib/sdk/errors"
import { isNetworkClassErrorKind, MAX_NON_RETRYABLE_REJECTIONS } from "@filen/shared"

export { MAX_NON_RETRYABLE_REJECTIONS }

// Thin adapter over the shared kind-name allowlist (@filen/shared's sdkRetryPolicy): the web worker's
// structured-clone-safe ErrorDTO `kind` string is already the raw kind name, no reverse-map needed
// (unlike mobile's numeric uniffi ErrorKind enum).
export function isNetworkClassError(error: unknown): boolean {
	const dto = asErrorDTO(error)

	return isNetworkClassErrorKind(dto.species === "sdk" ? dto.kind : undefined)
}
