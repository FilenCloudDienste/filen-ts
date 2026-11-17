// Byte helpers for the header readers: every read is bounds-checked and reads past the end as zero, so a hostile
// offset gives a wrong value, never an exception or a huge allocation.

export function u16(bytes: Uint8Array, at: number, little: boolean): number {
	const a = bytes[at] ?? 0
	const b = bytes[at + 1] ?? 0

	return little ? a | (b << 8) : (a << 8) | b
}

export function u32(bytes: Uint8Array, at: number, little: boolean): number {
	const a = bytes[at] ?? 0
	const b = bytes[at + 1] ?? 0
	const c = bytes[at + 2] ?? 0
	const d = bytes[at + 3] ?? 0

	return (little ? a + b * 0x100 + c * 0x10000 + d * 0x1000000 : d + c * 0x100 + b * 0x10000 + a * 0x1000000) >>> 0
}

// A 64-bit value as a number, or null past 2^53.
export function u64(bytes: Uint8Array, at: number, little: boolean): number | null {
	const low = u32(bytes, little ? at : at + 4, little)
	const high = u32(bytes, little ? at + 4 : at, little)

	return high >= 0x200000 ? null : high * 0x100000000 + low
}

export function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
	return magic.every((byte, index) => bytes[at + index] === byte)
}

// ASCII text in a fixed field, trailing spaces and NULs cut; null when empty. Controls and non-ASCII bytes read as "?".
export function asciiField(bytes: Uint8Array, start: number, end: number): string | null {
	let text = ""

	for (let index = start; index < Math.min(end, bytes.length); index++) {
		const byte = bytes[index] ?? 0

		text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : byte === 0 ? "\0" : "?"
	}

	const trimmed = text.replace(/[\s\0]+$/, "").replace(/\0/g, "")

	return trimmed === "" ? null : trimmed
}

// A NUL-terminated ASCII string from `at`, at most `max` bytes.
export function cString(bytes: Uint8Array, at: number, max: number): string | null {
	let end = at

	while (end < bytes.length && end - at < max && bytes[end] !== 0) end++

	return asciiField(bytes, at, end)
}

const UTF16LE = new TextDecoder("utf-16le")
const UTF16BE = new TextDecoder("utf-16be")

// UTF-16 text (version resources are little-endian, Joliet names big-endian), format controls out.
export function utf16(bytes: Uint8Array, start: number, end: number, little: boolean): string {
	const view = bytes.subarray(Math.max(0, start), Math.max(start, Math.min(end, bytes.length)))

	return (little ? UTF16LE : UTF16BE)
		.decode(view.subarray(0, view.length - (view.length % 2)))
		.replace(/(?![‌‍])\p{Cf}/gu, "")
		.replace(/\0[\s\S]*$/, "")
}

export function hex(value: number, digits = 4): string {
	return `0x${value.toString(16).padStart(digits, "0")}`
}
