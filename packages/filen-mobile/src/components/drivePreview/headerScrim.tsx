import { StyleSheet } from "react-native"
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg"

/**
 * How long the scrim takes to fade in once the document starts scrolling, and out again at the top.
 *
 * The signal behind it is a threshold crossing, not a scroll offset (see scrollReporting), so this
 * is what supplies the motion — short enough to feel attached to the gesture, long enough not to
 * read as a hard cut.
 */
export const SCRIM_FADE_DURATION_MS = 200

/**
 * Backdrop for the preview header where it stays transparent over scrolling content.
 *
 * The WebView previews extend edge to edge (see domKeyboardHost's DOM_HOST_WEBVIEW_PROPS), so their
 * content passes UNDER this overlaid header rather than stopping below it. Over a document that is
 * mostly text, the title and the status bar then compete with whatever line happens to be behind
 * them. A fade keeps both readable without making the header opaque, which is what the previews that
 * DO use an opaque header (pdf, docx, video) already do instead.
 *
 * Drawn with react-native-svg rather than a gradient package: it is already a dependency, so this
 * costs no native module and no rebuild.
 */
export function HeaderScrim({ color }: { color: string }) {
	return (
		<Svg
			style={StyleSheet.absoluteFill}
			pointerEvents="none"
		>
			<Defs>
				<LinearGradient
					id="drivePreviewHeaderScrim"
					x1="0"
					y1="0"
					x2="0"
					y2="1"
				>
					<Stop
						offset="0"
						stopColor={color}
						stopOpacity={0.75}
					/>
					<Stop
						offset="0.65"
						stopColor={color}
						stopOpacity={0.35}
					/>
					<Stop
						offset="1"
						stopColor={color}
						stopOpacity={0}
					/>
				</LinearGradient>
			</Defs>
			<Rect
				x="0"
				y="0"
				width="100%"
				height="100%"
				fill="url(#drivePreviewHeaderScrim)"
			/>
		</Svg>
	)
}

/**
 * Whether the header needs the scrim: only where it is transparent AND the content behind it
 * scrolls. The opaque-header previews hide their content outright, and the ones that centre a single
 * piece of media (image, audio) have nothing running under the title to disambiguate.
 *
 * Pure so the rule is testable without a renderer.
 */
export function drivePreviewHeaderNeedsScrim({ previewType, solidHeader }: { previewType: string; solidHeader: boolean }): boolean {
	if (solidHeader) {
		return false
	}

	return previewType === "text" || previewType === "code"
}

export default HeaderScrim
