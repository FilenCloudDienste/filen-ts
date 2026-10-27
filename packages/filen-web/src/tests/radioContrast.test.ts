import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

const CSS = readFileSync("src/index.css", "utf8")
const RADIO = readFileSync("src/components/ui/radio-group.tsx", "utf8")

function tokens(selector: string): Record<string, string> {
	const variables: Record<string, string> = {}

	for (let start = CSS.indexOf(`\n${selector} {\n`); start !== -1; start = CSS.indexOf(`\n${selector} {\n`, start + 1)) {
		for (const line of CSS.slice(start, CSS.indexOf("}", start)).split("\n")) {
			const match = /^\s*--([\w-]+):\s*(.+);$/u.exec(line)

			if (match?.[1] !== undefined && match[2] !== undefined) {
				variables[match[1]] = match[2]
			}
		}
	}

	return variables
}

// oklch() to linear sRGB plus alpha (CSS Color 4 OKLab matrices).
function linear(css: string): [number, number, number, number] {
	const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)$/u.exec(css)

	if (!match) {
		throw new Error(`not an oklch token: ${css}`)
	}

	const l = Number(match[1])
	const c = Number(match[2])
	const h = (Number(match[3]) * Math.PI) / 180
	const a = c * Math.cos(h)
	const b = c * Math.sin(h)
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
	const clamp = (value: number): number => Math.min(1, Math.max(0, value))

	return [
		clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
		clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
		clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
		match[4] === undefined ? 1 : Number(match[4]) / 100
	]
}

// Browsers composite in gamma-encoded sRGB, so blend there and decode for luminance.
function luminance(css: string, backdrop: string): number {
	const encode = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
	const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
	const [r, g, b, alpha] = linear(css)
	const under = linear(backdrop)
	const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((v, k) => decode(encode(v) * alpha + encode(under[k] ?? 0) * (1 - alpha)))

	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrast(color: string, surface: string): number {
	const [hi = 0, lo = 0] = [luminance(color, surface), luminance(surface, surface)].sort((x, y) => y - x)

	return (hi + 0.05) / (lo + 0.05)
}

// The radio's unselected border token, read from its base (unprefixed) border-colour utility.
function unselectedBorderToken(): string {
	const classes = /className=\{cn\(\s*"([^"]+)"/u.exec(RADIO.slice(RADIO.indexOf("function RadioGroupItem")))?.[1]?.split(" ") ?? []
	const borders = classes.filter(name => /^border-[a-z]/u.test(name))

	expect(borders).toHaveLength(1)

	return (borders[0] ?? "").slice("border-".length)
}

describe("radio contrast", () => {
	// Card is --background; dialogs and popovers are --popover.
	it.each([":root", ".dark"])(
		"draws the unselected ring at WCAG 1.4.11 non-text contrast (3:1) on card, dialog and popover surfaces in %s",
		selector => {
			const theme = { ...tokens(":root"), ...tokens(selector) }
			const ring = theme[unselectedBorderToken()] ?? ""

			for (const surface of ["background", "popover"]) {
				expect(contrast(ring, theme[surface] ?? "")).toBeGreaterThanOrEqual(3)
				expect(contrast(theme["destructive"] ?? "", theme[surface] ?? "")).toBeGreaterThanOrEqual(3)
			}

			// An invalid radio swaps its ring for the full destructive colour in both themes.
			expect(RADIO).toContain('"dark:aria-invalid:border-destructive"')
		}
	)
})
