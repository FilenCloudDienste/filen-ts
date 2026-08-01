import type { Font, TextEditorType } from "@/components/textEditor"
import { VIEWPORT_HEIGHT } from "@/lib/domViewport"

/**
 * The CodeMirror editor's box model, kept in one place so the keyboard fix cannot be undone by a
 * later styling change that looks harmless (#102).
 *
 * Deliberately a plain spec object rather than an `EditorView.theme()` extension: this module stays
 * importable — and assertable — without pulling CodeMirror into a test.
 */

/**
 * A DEFINITE height, never a minimum.
 *
 * Both fill the page, which is what an empty note needs so that a tap anywhere focuses the editor
 * rather than only the sliver its content occupies (#67). Only a definite one resolves
 * `.cm-scroller`'s `height: 100%`, which is what makes the scroller — rather than the page — the
 * thing that scrolls. Under a minimum the editor grew past the viewport and the PAGE scrolled, so
 * CodeMirror measured caret visibility against `innerHeight`: a viewport that still includes the
 * strip the keyboard covers.
 */
export const CODE_MIRROR_HEIGHT = VIEWPORT_HEIGHT

export const CODE_MIRROR_WIDTH = "100dvw"

/**
 * Spread onto `<CodeMirror>` rather than passed prop-by-prop, so that "definite, not a minimum" is
 * a property of one object a test can assert instead of a call site anyone can retype.
 * `@uiw/react-codemirror` accepts `height`, `minHeight` and `maxHeight` and emits whichever it is
 * given onto `.cm-editor` — only `height` produces the bounded box the caret logic depends on.
 */
export const CODE_MIRROR_DIMENSIONS = {
	width: CODE_MIRROR_WIDTH,
	height: CODE_MIRROR_HEIGHT
} as const

// eslint-disable-next-line quotes
const DEFAULT_FONT_FAMILY = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

/**
 * Prose reads at a larger size than code.
 *
 * The two callers below key off DIFFERENT flags, which only diverge for a `.txt` file opened as
 * code — `isTextFile` covers it, `type` does not. Kept as-is rather than unified: the host always
 * supplies `font.size`, so the fallbacks decide nothing today, and collapsing them would be a silent
 * restyle rather than a fix.
 */
function fontSize(isProse: boolean, font?: Font): number {
	return font?.size ?? (isProse ? 16 : 14)
}

export function createLayoutThemeSpec({
	type,
	isTextFile,
	font,
	paddingTop,
	paddingBottom
}: {
	type: TextEditorType
	/** Plain prose rather than source: no gutters, larger type. */
	isTextFile: boolean
	font?: Font
	paddingTop?: number
	paddingBottom?: number
}): Record<string, Record<string, string>> {
	const editorFontSize = fontSize(type === "text", font)
	const lineFontSize = fontSize(isTextFile, font)

	return {
		"&": {
			outline: "none !important",
			fontSize: `${editorFontSize}px !important`,
			fontFamily: `${font?.family ?? DEFAULT_FONT_FAMILY} !important`
		},
		// Padding belongs on the SCROLLED content, never on `&`. `.cm-editor` is a fixed-height box
		// (CODE_MIRROR_HEIGHT), so padding there is a strip the document can never move through — and
		// the drive preview's paddingTop exists precisely so content scrolls UNDER its overlaid
		// header. CodeMirror reads this back as `documentPadding` and offsets the gutters by it, so
		// line numbers stay aligned with their lines.
		".cm-content": {
			// Horizontal breathing room for prose only; code keeps its gutter flush to the edge.
			// Left unset otherwise so CodeMirror's own `4px 0` survives.
			...(type === "text"
				? {
						padding: "16px"
					}
				: {}),
			...(paddingTop
				? {
						paddingTop: `${paddingTop}px`
					}
				: {}),
			...(paddingBottom
				? {
						paddingBottom: `${paddingBottom}px`
					}
				: {})
		},
		"&.cm-focused": {
			outline: "none !important",
			border: "none !important",
			boxShadow: "none !important"
		},
		"&:focus-visible": {
			outline: "none !important"
		},
		// Only reached when isTextFile is false, so lineFontSize is the gutter's size too.
		".cm-gutters": isTextFile
			? {
					display: "none !important"
				}
			: {
					fontSize: `${lineFontSize}px !important`,
					fontFamily: `${font?.family ?? "inherit"} !important`
				},
		".cm-line": {
			...(isTextFile
				? {
						lineHeight: `${font?.lineHeight ?? 1.5} !important`
					}
				: {}),
			fontSize: `${lineFontSize}px !important`,
			fontFamily: `${font?.family ?? "inherit"} !important`
		}
	}
}
