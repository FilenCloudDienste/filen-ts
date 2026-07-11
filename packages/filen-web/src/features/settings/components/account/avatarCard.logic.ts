// Pure avatar-file validation, split out of the component (react-refresh requires a component
// file to export components only) so it is unit-testable without a DOM. Mirrors old-web's
// settings/account avatar input exactly (`file.size >= 1024 * 1024 * 2` + `accept="image/png,
// image/jpeg, image/jpg"`) — the current web precedent, not mobile's native image-manipulator
// pipeline (there is no equivalent transcode step in a browser without a heavier dependency this
// codebase doesn't need).
export const AVATAR_MAX_BYTES = 1024 * 1024 * 2
export const AVATAR_ACCEPTED_TYPES = new Set(["image/png", "image/jpeg"])

export type AvatarValidationResult = { status: "ok" } | { status: "invalidType" } | { status: "tooLarge" }

export function validateAvatarFile(file: { type: string; size: number }): AvatarValidationResult {
	if (!AVATAR_ACCEPTED_TYPES.has(file.type.toLowerCase())) {
		return { status: "invalidType" }
	}

	if (file.size > AVATAR_MAX_BYTES) {
		return { status: "tooLarge" }
	}

	return { status: "ok" }
}
