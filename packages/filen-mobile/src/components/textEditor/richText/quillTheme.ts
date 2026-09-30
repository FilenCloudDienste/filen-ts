import type { Colors, Font } from "@/components/textEditor"

export type QuillThemeOptions = {
	containerBorder?: string
	containerBackground?: string
	checkmarkColor?: string
	editorFontFamily?: string
	editorFontSize?: string
	editorLineHeight?: string
	editorPadding?: string
	// Applied to `.ql-editor`, which IS the scroller, so these scroll with the document. On the
	// container around it they would be a fixed gutter instead — a strip the text can never move
	// through, and the host's paddingTop exists so content scrolls UNDER a transparent header.
	editorPaddingTop?: string
	editorPaddingBottom?: string
	editorTextColor?: string
	editorBackground?: string
	placeholderColor?: string
	placeholderStyle?: string
	codeBackground?: string
	codeTextColor?: string
	// The blockquote mark is a BORDER, not a surface, so it needs a colour that stands out
	// against the editor background rather than the neutral one a code block sits on.
	blockquoteBorderColor?: string
	editorFontWeight?: string
}

// The toolbar is native (toolbar.tsx) and Quill runs with `toolbar: false`, so Snow never builds its
// toolbar, pickers or tooltip; only editor content is styled here.
export class QuillThemeCustomizer {
	private options: QuillThemeOptions
	private styleId: string = "quill-custom-styles"

	public constructor(options: QuillThemeOptions = {}) {
		this.options = {
			containerBorder: "none",
			containerBackground: "transparent",
			checkmarkColor: "#f5f5f5",
			editorFontFamily: "Helvetica Neue, Arial, sans-serif",
			editorFontSize: "16px",
			editorLineHeight: "1.6",
			editorPadding: "20px",
			editorTextColor: "#333",
			editorBackground: "white",
			placeholderColor: "#aaa",
			placeholderStyle: "italic",
			...options
		}
	}

	public apply(): void {
		this.removeExistingStyles()

		const style = document.createElement("style")

		style.id = this.styleId
		style.textContent = this.generateCSS()

		document.head.appendChild(style)
	}

	public removeExistingStyles(): void {
		const existingStyle = document.getElementById(this.styleId)

		if (existingStyle && existingStyle.parentNode) {
			existingStyle.parentNode.removeChild(existingStyle)
		}
	}

	private generateCSS(): string {
		return `
			/* Container styling */
			.ql-container {
				flex: 1 1 auto !important;
				border: ${this.options.containerBorder} !important;
				background-color: ${this.options.containerBackground} !important;
				width: 100vw !important;
			}

			/* Editor content styling */
			.ql-editor {
				/* Belt for #78: quill.snow.css declares no width — never let the
				   contenteditable shrink below its container again. */
				width: 100% !important;
				font-family: ${this.options.editorFontFamily} !important;
				font-size: ${this.options.editorFontSize} !important;
				line-height: ${this.options.editorLineHeight} !important;
				font-weight: ${this.options.editorFontWeight} !important;
				padding: ${this.options.editorPadding} !important;
				color: ${this.options.editorTextColor} !important;
				background-color: ${this.options.editorBackground} !important;
			}

			${this.options.editorPaddingTop ? `.ql-editor { padding-top: ${this.options.editorPaddingTop} !important; }` : ""}
			${this.options.editorPaddingBottom ? `.ql-editor { padding-bottom: ${this.options.editorPaddingBottom} !important; }` : ""}
			
			/* Placeholder styling */
			.ql-editor.ql-blank::before {
				color: ${this.options.placeholderColor} !important;
				font-style: ${this.options.placeholderStyle} !important;
			}

			/* Checkboxes styling.
			 *
			 * .ql-ui is the span Quill attaches the toggle handler to, and it is the box that has to
			 * line up with the circle drawn below — a tap that lands outside it does not toggle.
			 * Quill positions it absolutely and lets it shrink-wrap its marker, and its marker rule
			 * carries margin-left: -1.5em to pull the glyph back into the list item's gutter. A
			 * negative margin SHRINKS a shrink-to-fit box, so with the 16px circle below the span
			 * collapses to ~4px and ends up sitting beside the circle rather than on it: the only
			 * reliably tappable strip is the few pixels along the circle's right edge, and whether
			 * any of the circle itself responds depends on the engine routing an overflowing
			 * ::before back to its originating element.
			 *
			 * So move the pull-back onto the span itself and give it the gutter as its width. The
			 * circle lands in exactly the same place, now inside the box that receives the tap.
			 *
			 * The pull-back has to stay a MARGIN rather than become a left offset: .ql-ui is positioned
			 * against the list item, whose padding-left grows with each indent level, so only the
			 * static position tracks an indented item's marker. Anchoring to the item's edge instead
			 * would drag every nested checkbox back to the far left.
			 *
			 * Checklist markers only — bullets and ordered numbers are not interactive and keep
			 * Quill's right-aligned-in-the-gutter geometry.
			 */
			.ql-editor li[data-list=unchecked] > .ql-ui,
			.ql-editor li[data-list=checked] > .ql-ui {
				margin-left: -1.5em;
				width: 1.5em;
			}

			.ql-editor li[data-list=unchecked] > .ql-ui:before {
				content: '\\2713';
				color: transparent;
				display: inline-block;
				width: 16px;
				height: 16px;
				border: 1px solid ${this.options.editorTextColor};
				border-radius: 50%;
				margin-left: 0;
				margin-right: 0.5em;
				text-align: center;
				line-height: 17px;
				background-color: transparent;
			}

			.ql-editor li[data-list=checked] > .ql-ui:before {
				content: '\\2714';
				color: ${this.options.checkmarkColor};
				display: inline-block;
				width: 16px;
				height: 16px;
				border: 1px solid ${this.options.editorTextColor};
				border-radius: 50%;
				margin-left: 0;
				margin-right: 0.5em;
				text-align: center;
				line-height: 17px;
				background-color: ${this.options.editorTextColor};
			}

			.ql-editor li[data-list=checked] {
				text-decoration: line-through !important;
			}

			.ql-snow .ql-editor blockquote {
				border-left: 4px solid ${this.options.blockquoteBorderColor} !important;
			}

			.ql-snow .ql-editor .ql-code-block-container {
				background-color: ${this.options.codeBackground} !important;
				color: ${this.options.codeTextColor} !important;
				border-radius: 6px !important;
			}
    	`
	}
}

export function getThemeOptions({
	colors,
	font,
	paddingTop,
	paddingBottom
}: {
	colors: Colors
	font?: Font
	paddingTop?: number
	paddingBottom?: number
}): QuillThemeOptions {
	const padding: QuillThemeOptions = {
		editorPadding: "16px",
		...(paddingTop
			? {
					editorPaddingTop: `${paddingTop}px`
				}
			: {}),
		...(paddingBottom
			? {
					editorPaddingBottom: `${paddingBottom}px`
				}
			: {})
	}

	return {
		containerBorder: "none",
		containerBackground: "transparent",
		checkmarkColor: colors.background.primary,
		editorFontFamily: font?.family ?? "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
		editorFontSize: `${font?.size ?? 14}px`,
		editorLineHeight: `${font?.lineHeight ?? 1.5}`,
		editorFontWeight: `${font?.weight ?? 400}`,
		...padding,
		editorTextColor: colors.text.foreground,
		editorBackground: "transparent",
		placeholderColor: colors.text.muted,
		placeholderStyle: "normal",
		codeBackground: colors.background.secondary,
		codeTextColor: colors.text.foreground,
		blockquoteBorderColor: colors.background.accent
	}
}

export default QuillThemeCustomizer
