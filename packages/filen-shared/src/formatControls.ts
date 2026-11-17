// Format and bidi control characters (Unicode Cf: U+202E and the like, which can make a name read as another) taken out
// of text shown from a file, but ZWNJ and ZWJ, which scripts need to keep letters apart or join them.
const FORMAT_CONTROLS = /(?![‌‍])\p{Cf}/gu

export function withoutFormatControls(text: string): string {
	return text.replace(FORMAT_CONTROLS, "")
}
