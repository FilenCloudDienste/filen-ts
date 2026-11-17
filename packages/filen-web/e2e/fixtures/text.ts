import { scenarioModule } from "./scenarios"

// The text family's read-only files (preview-text-read.spec.ts): a legacy-encoded text the detector has to name, and
// markdown with math and images a preview must never fetch.

// Russian prose, long enough for the detector to settle on its codepage.
export const LEGACY_CYRILLIC_TEXT =
	"Съешь же ещё этих мягких французских булок, да выпей чаю.\n" +
	"Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.\n" +
	"В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!\n"

// The same bytes as KOI8-R reads them (Reopen with encoding), first line.
export const LEGACY_CYRILLIC_AS_KOI8_PREFIX = "яЗЕЬЭ ФЕ"

// Images by URL that the preview names instead of loading: one on a Filen host, one elsewhere.
export const MATH_REMOTE_IMAGES = ["https://cdn.filen.io/e2e-never-fetched.png", "https://example.com/e2e-never-fetched.png"] as const

export const MATH_MARKDOWN_TEXT =
	"# Formulas\n\n" +
	"Euler's identity $e^{i\\pi} + 1 = 0$ inline.\n\n" +
	"$$\n\\frac{a}{b} = \\sqrt{c}\n$$\n\n" +
	"It costs $5 and $10 today.\n\n" +
	`![chart](${MATH_REMOTE_IMAGES[0]}) ![photo](${MATH_REMOTE_IMAGES[1]})\n`

// A single-byte codepage's encoder, from the platform's own decoder (Node reads every WHATWG label).
export function encodeSingleByte(text: string, label: string): Buffer {
	const decoded = new TextDecoder(label).decode(Uint8Array.from({ length: 256 }, (_, byte) => byte))
	const table = new Map<string, number>()

	for (let byte = 255; byte >= 0; byte--) {
		table.set(decoded[byte] ?? "", byte)
	}

	// A single-byte codepage holds BMP characters only: one UTF-16 unit each.
	return Buffer.from(
		Array.from({ length: text.length }, (_, index) => {
			const char = text.charAt(index)
			const byte = table.get(char)

			if (byte === undefined) {
				throw new Error(`${label} has no byte for ${char}`)
			}

			return byte
		})
	)
}

export const TEXT_SCENARIOS = scenarioModule(
	{
		"preview-text-legacy": ["cyrillic-notes.txt"],
		"preview-markdown-math": ["formulas.md"]
	},
	() => ({
		"cyrillic-notes.txt": { buffer: encodeSingleByte(LEGACY_CYRILLIC_TEXT, "windows-1251"), mimeType: "text/plain" },
		"formulas.md": { buffer: Buffer.from(MATH_MARKDOWN_TEXT, "utf8"), mimeType: "text/markdown" }
	})
)
