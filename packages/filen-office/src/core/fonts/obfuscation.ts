import { FontError } from "./errors"

// Fonts embedded in WordprocessingML (ECMA-376 Part 1, font embedding) are obfuscated: the first 32 bytes
// are XORed with the 16 bytes of the w:fontKey GUID, taken in reverse order of its hex digits. XOR is its
// own inverse.

const OBFUSCATED_BYTES = 32

// The 16 key bytes of a GUID such as "{75E47363-20F1-45D4-9A84-815E26C8EAAE}" (braces optional).
export function parseFontKey(guid: string): Uint8Array {
	const hex = guid
		.trim()
		.replace(/^\{|\}$/g, "")
		.replaceAll("-", "")

	if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new FontError("invalidKey", "The font key is not a GUID")

	const key = new Uint8Array(16)

	for (let i = 0; i < 16; i++) key[15 - i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)

	return key
}

// Applies the obfuscation XOR. In place only when the caller owns `data`: an entry stored uncompressed in a
// zip is read as a view of the document bytes, and those must not change.
export function deobfuscateFont(data: Uint8Array, fontKey: string | Uint8Array, inPlace: boolean = false): Uint8Array {
	const key = typeof fontKey === "string" ? parseFontKey(fontKey) : fontKey

	if (key.length !== 16) throw new FontError("invalidKey", "The font key must be 16 bytes")
	if (data.length < OBFUSCATED_BYTES) throw new FontError("truncated", "Too short for an embedded font")

	const out = inPlace ? data : data.slice()

	for (let i = 0; i < OBFUSCATED_BYTES; i++) out[i] = (out[i] ?? 0) ^ (key[i % 16] ?? 0)

	return out
}
