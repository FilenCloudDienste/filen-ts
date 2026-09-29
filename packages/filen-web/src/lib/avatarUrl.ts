// An SDK avatar field as an image source, only when it is a real https URL: the field can carry a
// non-URL placeholder. Undefined falls the caller back to the initials avatar.
export function safeAvatarUrl(avatar: string | undefined): string | undefined {
	return avatar?.startsWith("https://") === true ? avatar : undefined
}
