// First character of the display name, uppercased — the avatar fallback when no image loads. "?" only
// covers the type-level empty-string case (email is never empty in practice).
export function contactInitials(displayName: string): string {
	const trimmed = displayName.trim()
	return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : "?"
}
