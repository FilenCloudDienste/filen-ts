import Quill from "quill"
import type { Platform } from "react-native"
import type { Colors, Font } from "@/components/textEditor"

export type QuillThemeOptions = {
	containerBorder?: string
	containerBackground?: string
	toolbarBorder?: string
	toolbarBackground?: string
	toolbarColor?: string
	toolbarActiveColor?: string
	toolbarHoverColor?: string
	toolbarBorderRadius?: string
	toolbarStrokeColor?: string
	toolbarFillColor?: string
	toolbarActiveStrokeColor?: string
	toolbarActiveFillColor?: string
	toolbarHoverStrokeColor?: string
	toolbarHoverFillColor?: string
	toolbarShadow?: string
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
	editorMinHeight?: string
	placeholderColor?: string
	placeholderStyle?: string
	customClass?: string
	codeBackground?: string
	codeTextColor?: string
	// The blockquote mark is a BORDER, not a surface, so it needs a colour that stands out
	// against the editor background rather than the neutral one a code block sits on.
	blockquoteBorderColor?: string
	editorFontWeight?: string
}

export class QuillThemeCustomizer {
	private options: QuillThemeOptions
	private styleId: string = "quill-custom-styles"

	public constructor(options: QuillThemeOptions = {}) {
		this.options = {
			containerBorder: "none",
			containerBackground: "transparent",
			toolbarBorder: "none",
			toolbarBackground: "#f5f5f5",
			toolbarColor: "#444", // Match Snow theme default
			toolbarActiveColor: "#06c", // Match Snow theme default
			toolbarHoverColor: "#06c", // Match Snow theme default
			// Add specific toolbar SVG element coloring
			toolbarStrokeColor: "#444", // Default stroke color
			toolbarFillColor: "#444", // Default fill color
			toolbarActiveStrokeColor: "#06c", // Active/selected stroke
			toolbarActiveFillColor: "#06c", // Active/selected fill
			toolbarHoverStrokeColor: "#06c", // Hover stroke
			toolbarHoverFillColor: "#06c", // Hover fill
			toolbarBorderRadius: "4px",
			editorFontFamily: "Helvetica Neue, Arial, sans-serif",
			editorFontSize: "16px",
			editorLineHeight: "1.6",
			editorPadding: "20px",
			editorTextColor: "#333",
			editorBackground: "white",
			editorMinHeight: "100vh",
			placeholderColor: "#aaa",
			placeholderStyle: "italic",
			...options
		}
	}

	public apply(quillInstance: Quill, containerId?: string): void {
		this.removeExistingStyles()

		const css = this.generateCSS(containerId)
		const style = document.createElement("style")

		style.id = this.styleId
		style.textContent = css

		document.head.appendChild(style)

		if (this.options.customClass && quillInstance) {
			const container = quillInstance.container

			if (container) {
				container.classList.add(this.options.customClass)
			}
		}
	}

	public removeExistingStyles(): void {
		const existingStyle = document.getElementById(this.styleId)

		if (existingStyle && existingStyle.parentNode) {
			existingStyle.parentNode.removeChild(existingStyle)
		}
	}

	private generateCSS(containerId?: string): string {
		const selector = containerId ? `#${containerId} ` : ""

		return `
			${selector} .ql-toolbar {
				top: 0 !important;
				position: sticky !important;
				z-index: 100 !important;
				width: 100% !important;
				flex: 0 0 auto !important;
			}

			/* Container styling */
			${selector} .ql-container {
				width: 100% !important;
				flex: 1 1 auto !important;
			}

			/* Container styling */
			${selector} .ql-container {
				border: ${this.options.containerBorder} !important;
				background-color: ${this.options.containerBackground} !important;
				width: 100vw !important;
			}
		
			/* Toolbar styling */
			${selector} .ql-toolbar {
				border: 1px solid transparent !important;
				border-bottom: none !important;
				background-color: ${this.options.codeBackground} !important;
				border-radius: none !important;
			}
			
			/* Default toolbar colors */
			${selector} .ql-toolbar button,
			${selector} .ql-toolbar .ql-picker-label {
				color: ${this.options.toolbarColor} !important;
			}
			
			/* Default toolbar colors */
			${selector} .ql-toolbar button,
			${selector} .ql-toolbar .ql-picker-label {
				color: ${this.options.toolbarColor} !important;
			}
			
			${selector} .ql-toolbar .ql-stroke {
				stroke: ${this.options.toolbarStrokeColor} !important;
			}
			
			${selector} .ql-toolbar .ql-fill,
			${selector} .ql-toolbar .ql-stroke.ql-fill {
				fill: ${this.options.toolbarFillColor} !important;
			}
			
			/* Active states */
			${selector} .ql-toolbar button.ql-active,
			${selector} .ql-toolbar .ql-picker-label.ql-active,
			${selector} .ql-toolbar .ql-picker-item.ql-selected {
				color: ${this.options.toolbarActiveColor} !important;
			}
			
			${selector} .ql-toolbar button.ql-active .ql-stroke,
			${selector} .ql-toolbar .ql-picker-label.ql-active .ql-stroke,
			${selector} .ql-toolbar .ql-picker-item.ql-selected .ql-stroke,
			${selector} .ql-toolbar button.ql-active .ql-stroke-miter,
			${selector} .ql-toolbar .ql-picker-label.ql-active .ql-stroke-miter,
			${selector} .ql-toolbar .ql-picker-item.ql-selected .ql-stroke-miter {
				stroke: ${this.options.toolbarActiveStrokeColor} !important;
			}
			
			${selector} .ql-toolbar button.ql-active .ql-fill,
			${selector} .ql-toolbar .ql-picker-label.ql-active .ql-fill,
			${selector} .ql-toolbar .ql-picker-item.ql-selected .ql-fill,
			${selector} .ql-toolbar button.ql-active .ql-stroke.ql-fill,
			${selector} .ql-toolbar .ql-picker-label.ql-active .ql-stroke.ql-fill,
			${selector} .ql-toolbar .ql-picker-item.ql-selected .ql-stroke.ql-fill {
				fill: ${this.options.toolbarActiveFillColor} !important;
			}
			
			/* Hover states */
			${selector} .ql-toolbar button:hover,
			${selector} .ql-toolbar button:focus,
			${selector} .ql-toolbar .ql-picker-label:hover,
			${selector} .ql-toolbar .ql-picker-item:hover {
				color: ${this.options.toolbarHoverColor} !important;
			}
			
			${selector} .ql-toolbar button:hover .ql-stroke,
			${selector} .ql-toolbar button:focus .ql-stroke,
			${selector} .ql-toolbar .ql-picker-label:hover .ql-stroke,
			${selector} .ql-toolbar .ql-picker-item:hover .ql-stroke,
			${selector} .ql-toolbar button:hover .ql-stroke-miter,
			${selector} .ql-toolbar button:focus .ql-stroke-miter,
			${selector} .ql-toolbar .ql-picker-label:hover .ql-stroke-miter,
			${selector} .ql-toolbar .ql-picker-item:hover .ql-stroke-miter {
				stroke: ${this.options.toolbarHoverStrokeColor} !important;
			}
			
			${selector} .ql-toolbar button:hover .ql-fill,
			${selector} .ql-toolbar button:focus .ql-fill,
			${selector} .ql-toolbar .ql-picker-label:hover .ql-fill,
			${selector} .ql-toolbar .ql-picker-item:hover .ql-fill,
			${selector} .ql-toolbar button:hover .ql-stroke.ql-fill,
			${selector} .ql-toolbar button:focus .ql-stroke.ql-fill,
			${selector} .ql-toolbar .ql-picker-label:hover .ql-stroke.ql-fill,
			${selector} .ql-toolbar .ql-picker-item:hover .ql-stroke.ql-fill {
				fill: ${this.options.toolbarHoverFillColor} !important;
			}
			
			/* Editor content styling */
			${selector} .ql-editor {
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

			${this.options.editorPaddingTop ? `${selector} .ql-editor { padding-top: ${this.options.editorPaddingTop} !important; }` : ""}
			${this.options.editorPaddingBottom ? `${selector} .ql-editor { padding-bottom: ${this.options.editorPaddingBottom} !important; }` : ""}
			
			/* Placeholder styling */
			${selector} .ql-editor.ql-blank::before {
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
			${selector} .ql-editor li[data-list=unchecked] > .ql-ui,
			${selector} .ql-editor li[data-list=checked] > .ql-ui {
				margin-left: -1.5em;
				width: 1.5em;
			}

			${selector} .ql-editor li[data-list=unchecked] > .ql-ui:before {
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

			${selector} .ql-editor li[data-list=checked] > .ql-ui:before {
				content: '\\2714';
				color: ${this.options.toolbarBackground};
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

			${selector} .ql-editor li[data-list=checked] {
				text-decoration: line-through !important;
			}

			${selector} .ql-snow .ql-picker-options {
				background-color: ${this.options.codeBackground} !important;
				border-radius: ${this.options.toolbarBorderRadius} !important;
			}

			${selector} .ql-toolbar.ql-snow .ql-picker.ql-expanded .ql-picker-options {
				border-color: ${this.options.toolbarBorder} !important;
				border: none !important;
			}

			${selector} .ql-toolbar.ql-snow .ql-picker-options {
				border: 1px solid ${this.options.toolbarBorder} !important;
				border-color: ${this.options.toolbarBorder} !important;
				border-radius: ${this.options.toolbarBorderRadius} !important;
				background-color: ${this.options.codeBackground} !important;
			}

			${selector} .ql-snow .ql-editor blockquote {
				border-left: 4px solid ${this.options.blockquoteBorderColor} !important;
			}

			${selector} .ql-toolbar.ql-snow .ql-picker.ql-expanded .ql-picker-label {
				border-color: transparent !important;
			}

			${selector} .ql-snow .ql-picker.ql-expanded .ql-picker-label {
				color: ${this.options.toolbarActiveColor} !important;
			}

			${selector} .ql-snow .ql-picker-options .ql-picker-item {
				color: ${this.options.toolbarColor} !important;
			}

			${selector} .ql-snow .ql-editor .ql-code-block-container {
				background-color: ${this.options.codeBackground} !important;
				color: ${this.options.codeTextColor} !important;
				border-radius: 6px !important;
			}

			${selector} .ql-snow .ql-tooltip {
				background-color: ${this.options.codeBackground} !important;
				color: ${this.options.codeTextColor} !important;
				border: none !important;
				border-radius: 6px !important;
				box-shadow: none !important;
			}

			${selector} .ql-snow .ql-tooltip input[type=text] {
				background-color: ${this.options.codeBackground} !important;
				color: ${this.options.codeTextColor} !important;
			}
    	`
	}
}

export function getThemeOptions({
	colors,
	platform,
	font,
	paddingTop,
	paddingBottom
}: {
	darkMode: boolean
	colors: Colors
	platform: Platform["OS"]
	font?: Font
	paddingTop?: number
	paddingBottom?: number
}): QuillThemeOptions {
	// Shared rather than repeated in both branches: the two differ only in the values above, and a
	// padding that reached one platform and not the other is exactly the kind of drift worth
	// designing out.
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

	if (platform === "ios") {
		return {
			containerBorder: "none",
			containerBackground: "transparent",
			toolbarBorder: "1px solid #2c2c2e",
			toolbarBackground: colors.background.primary,
			toolbarColor: colors.text.muted,
			toolbarStrokeColor: colors.text.muted,
			toolbarFillColor: colors.text.muted,
			toolbarActiveColor: colors.text.primary,
			toolbarActiveStrokeColor: colors.text.primary,
			toolbarActiveFillColor: colors.text.primary,
			toolbarHoverColor: colors.text.primary,
			toolbarHoverStrokeColor: colors.text.primary,
			toolbarHoverFillColor: colors.text.primary,
			toolbarBorderRadius: "6px",
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

	return {
		containerBorder: "none",
		containerBackground: "transparent",
		toolbarBorder: "1px solid #2c2c2e",
		toolbarBackground: colors.background.primary,
		toolbarColor: colors.text.muted,
		toolbarStrokeColor: colors.text.muted,
		toolbarFillColor: colors.text.muted,
		toolbarActiveColor: colors.text.primary,
		toolbarActiveStrokeColor: colors.text.primary,
		toolbarActiveFillColor: colors.text.primary,
		toolbarHoverColor: colors.text.primary,
		toolbarHoverStrokeColor: colors.text.primary,
		toolbarHoverFillColor: colors.text.primary,
		toolbarBorderRadius: "6px",
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
