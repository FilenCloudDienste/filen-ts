// UTF-8 length without encoding; a lone surrogate counts as the 3-byte U+FFFD it encodes to.
export function utf8Length(value: string): number {
	let length = 0

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if (code < 0x80) {
			length += 1
		} else if (code < 0x800) {
			length += 2
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			length += 4
			i++
		} else {
			length += 3
		}
	}

	return length
}

// The longest prefix of `value` within `maxBytes` UTF-8 bytes, never splitting a surrogate pair.
export function utf8Prefix(value: string, maxBytes: number): string {
	let length = 0

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3

		if (length + size > maxBytes) {
			return value.slice(0, i)
		}

		length += size

		if (pair) {
			i++
		}
	}

	return value
}
