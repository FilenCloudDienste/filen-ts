import type { ErrorDTO } from "@/lib/sdk/errors"

// Best-effort: does a rejected resolution look like "this link needs a password" rather than "this
// link is gone"? A file link has no up-front hasPassword flag (unlike a directory) — a protected file
// simply throws on getLinkedFile without the password — so the only signal available at this layer is
// the error text. Duck-typed against the ErrorDTO the worker boundary throws (kind/label/message),
// substring-matched case-insensitively — deliberately lenient, since misclassifying a password error
// as "unavailable" (or vice-versa) only changes which of two surfaces shows.
export function isPasswordError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	const dto = error as Partial<ErrorDTO>
	const haystack = `${dto.kind ?? ""} ${dto.label ?? ""} ${dto.message ?? ""}`.toLowerCase()

	return haystack.includes("password")
}
