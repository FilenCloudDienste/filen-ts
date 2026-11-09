import { ODF_HYPHENATION, ODF_STYLE_NS } from "../docx/layout/geometry"
import type { OdfStyle, OdfStyleSheet } from "../odf/styles"
import { parseLength } from "../odf/units"
import { twips } from "./wml"

// OpenDocument hyphenates a paragraph whose text properties say fo:hyphenate="true" (ODF 1.3 Part 3 §20.209; off by
// default), with its limits beside it: fo:hyphenation-remain-char-count and -push-char-count (§20.212, §20.211;
// LibreOffice's default 2), fo:hyphenation-ladder-count (§20.210; no-limit), and LibreOffice's loext:hyphenation-zone
// (0), -no-caps and -word-char-count (5). WordprocessingML hyphenates the whole document (w:autoHyphenation) unless a
// paragraph suppresses it (w:suppressAutoHyphens, which the translation writes from fo:hyphenate, every paragraph
// suppressed by default), with one set of limits: taken from the default paragraph style, else from the first
// style that hyphenates. The character counts have no WordprocessingML setting (ODF_HYPHENATION).

type Attribute =
	| "fo:hyphenation-remain-char-count"
	| "fo:hyphenation-push-char-count"
	| "fo:hyphenation-ladder-count"
	| "loext:hyphenation-zone"
	| "loext:hyphenation-no-caps"
	| "loext:hyphenation-word-char-count"

function hyphenates(style: OdfStyle | undefined): boolean {
	return style?.properties.get("text")?.attributes.get("fo:hyphenate") === "true"
}

function attribute(style: OdfStyle, name: Attribute): string | undefined {
	return style.properties.get("text")?.attributes.get(name) ?? style.properties.get("paragraph")?.attributes.get(name)
}

function count(value: string | undefined, fallback: number): number {
	const parsed = value === undefined ? Number.NaN : Number(value)

	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

// The styles whose limits count (the default paragraph style, then the common ones that hyphenate), or undefined
// when no paragraph style, common or automatic, hyphenates.
function hyphenating(sheet: OdfStyleSheet): OdfStyle[] | undefined {
	const defaults = sheet.defaults.get("paragraph")
	const styles: OdfStyle[] = defaults === undefined ? [] : [defaults]
	let any = hyphenates(defaults)

	for (const style of sheet.commonStyles("paragraph")) {
		if (!hyphenates(style)) continue

		styles.push(style)
		any = true
	}

	for (const scope of ["styles", "content"] as const) {
		if (any) break

		for (const name of sheet.automaticNames("paragraph", scope)) {
			if (hyphenates(sheet.style("paragraph", name, scope))) {
				any = true

				break
			}
		}
	}

	return any ? styles : undefined
}

// Whether some paragraph style hyphenates: the translation then suppresses hyphenation in every other paragraph.
export function odfHyphenates(sheet: OdfStyleSheet): boolean {
	return hyphenating(sheet) !== undefined
}

// The settings.xml elements for the document's hyphenation (after w:defaultTabStop), and its compatibility setting;
// empty when no style hyphenates.
export function hyphenationSettings(sheet: OdfStyleSheet): { readonly settings: string; readonly compat: string } {
	const styles = hyphenating(sheet)

	if (styles === undefined) return { settings: "", compat: "" }

	const value = (name: Attribute): string | undefined => {
		for (const style of styles) {
			const found = attribute(style, name)

			if (found !== undefined) return found
		}

		return undefined
	}
	const ladder = count(value("fo:hyphenation-ladder-count"), 0)
	const zone = Math.max(0, twips(parseLength(value("loext:hyphenation-zone")) ?? 0))
	const chars = [
		count(value("fo:hyphenation-remain-char-count"), 2),
		count(value("fo:hyphenation-push-char-count"), 2),
		count(value("loext:hyphenation-word-char-count"), 5)
	]

	return {
		settings: `<w:autoHyphenation/>${ladder > 0 ? `<w:consecutiveHyphenLimit w:val="${ladder}"/>` : ""}<w:hyphenationZone w:val="${zone}"/>${value("loext:hyphenation-no-caps") === "true" ? "<w:doNotHyphenateCaps/>" : ""}`,
		compat: `<w:compatSetting w:name="${ODF_HYPHENATION}" w:uri="${ODF_STYLE_NS}" w:val="${chars.join(" ")}"/>`
	}
}
