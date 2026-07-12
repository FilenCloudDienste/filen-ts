// Middle-truncation for opaque values (uuid / ip / user-agent) where the distinguishing part is as
// likely to sit at the tail as the head — Tailwind's `truncate` utility only ever clips from the end,
// which would eat a uuid's last segment or a user-agent's browser/version suffix. There is no CSS
// equivalent (text-overflow only supports one clip side), so this is a plain string transform the
// MiddleEllipsis component renders.
export function middleEllipsis(value: string, options?: { start?: number | undefined; end?: number | undefined }): string {
	const start = options?.start ?? 10
	const end = options?.end ?? 8

	// Truncating would not shorten (or would only add the ellipsis without dropping any real
	// characters) once the value is already at or below the kept-character budget — return as-is.
	if (value.length <= start + end + 1) {
		return value
	}

	return `${value.slice(0, start)}…${value.slice(value.length - end)}`
}
