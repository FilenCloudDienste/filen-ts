import { vi } from "vitest"

// The WHATWG windows-1252 index for bytes 0x80-0x9F (https://encoding.spec.whatwg.org/index-windows-1252.txt);
// every other byte is its own code point. Kept apart from the app's encoder table so a test checks one
// against the other.
const INDEX_80_9F = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018,
	0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
]

// Some Node releases (20.18.3 and 22.13.0 on, and 24 before 24.13.1) decode windows-1252 as Latin-1 (0x80 gives U+0080
// rather than the euro sign), unlike every browser and the Encoding standard. On such a runtime the global
// TextDecoder is swapped for one that maps those bytes through the standard's index, so the app's own
// decoding runs as it does in a browser. A runtime that decodes correctly is left alone.
export function standardWindows1252Decoding(): void {
	const Native = globalThis.TextDecoder

	if (new Native("windows-1252").decode(Uint8Array.of(0x80)) === "€") {
		return
	}

	class StandardTextDecoder extends Native {
		override decode(...args: Parameters<TextDecoder["decode"]>): string {
			const text = super.decode(...args)

			return this.encoding === "windows-1252"
				? text.replace(/[\u0080-\u009f]/g, char =>
						String.fromCharCode(INDEX_80_9F[char.charCodeAt(0) - 0x80] ?? char.charCodeAt(0))
					)
				: text
		}
	}

	vi.stubGlobal("TextDecoder", StandardTextDecoder)
}
