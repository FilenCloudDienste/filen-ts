// The SDK takes an archive password of 1 to 1024 characters (Unicode code points), exactly as typed.
export const ARCHIVE_PASSWORD_MAX_CHARS = 1024

export type ArchivePasswordProblem = "empty" | "tooLong"

export function archivePasswordProblem(password: string): ArchivePasswordProblem | null {
	if (password.length === 0) {
		return "empty"
	}

	// A code point is one or two UTF-16 units, so only a string this long can have too many.
	return password.length > ARCHIVE_PASSWORD_MAX_CHARS && Array.from(password).length > ARCHIVE_PASSWORD_MAX_CHARS ? "tooLong" : null
}
