// Latin-1 bytes of a string, one byte per character (tests write \'hh for anything else): dependency-free, so the
// reader and tokenizer tests take it without the docx editor the RTF writer fixtures pull in.
export function latin1(text: string): Uint8Array {
	const out = new Uint8Array(text.length)

	for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 0xff

	return out
}
