import { KeyboardAvoidingView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { cn } from "@filen/shared"

/**
 * Wrapper for a DOM (WebView) component whose page can take keyboard focus — #102.
 *
 * The native half of the keyboard fix; `src/lib/domViewport` is the half that runs inside the page,
 * and both are needed. This one shrinks the WebView so its LAYOUT viewport ends at the keyboard,
 * which is the part only native can do: on iOS WebKit otherwise leaves the layout viewport at full
 * height and reveals the caret by PANNING the visual viewport inside it, dragging the page up and
 * leaving a keyboard-sized band of nothing above the keyboard. Shrinking the view removes the room
 * it pans into. The CSS half then trims whatever is still obscured, measured by the engine itself.
 *
 * `automaticOffset` measures this view in window coordinates. Without it the overlap is derived from
 * onLayout, whose y is PARENT-relative — every one of these hosts sits under a header or inside a
 * modal, so the padding would fall short by that offset. Measuring the real position is also what
 * makes the Android navigation bar a non-issue: the view's bottom edge and the keyboard's top edge
 * are read in the same space, so whatever sits between them is already accounted for.
 *
 * Shared rather than repeated at each host because the props are unobvious enough that a copy would
 * eventually be "cleaned up" — a KeyboardAvoidingView with no `behavior` renders a plain View and
 * avoids nothing at all, which is exactly how this shipped before #102.
 */
/**
 * Native WebView props every DOM host wants, and the reason they belong together.
 *
 * iOS insets a WKWebView's scroll content by the safe area unless told otherwise — DomWebView.swift
 * defaults `contentInsetAdjustmentBehavior` to `.automatic` — so the page starts below the notch and
 * ends above the home indicator. Android has no equivalent, which is the whole of why the previews
 * looked different on the two platforms: bands top and bottom on iOS, edge to edge on Android.
 *
 * These hosts want the WebView edge to edge and keep their CONTENT clear of the safe area with page
 * padding instead (the `paddingTop`/`paddingBottom` each DOM component takes). That is not a
 * preference: the header is an overlay, so content has to be able to scroll UNDER it, which an inset
 * that shortens the scroll view cannot express — and doubling up with the page padding is what put
 * the content twice as far down as intended.
 */
export const DOM_HOST_WEBVIEW_PROPS = {
	bounces: false,
	contentInsetAdjustmentBehavior: "never"
} as const

export const DomKeyboardHost = ({ children, className }: { children: React.ReactNode; className?: string }) => {
	const insets = useSafeAreaInsets()

	return (
		<KeyboardAvoidingView
			className={cn("flex-1", className)}
			behavior="padding"
			automaticOffset={true}
			// Vertically these hosts run edge to edge and keep their CONTENT clear with page padding,
			// because content has to be able to scroll UNDER the overlaid header. Horizontally there is
			// nothing to scroll under — in landscape that inset IS the sensor housing — so the VIEW stops
			// short of it instead. That distinction matters: page padding would leave the docx viewer's
			// white paper rendered beneath the cutout, which is what it did.
			//
			// Zero in portrait on both platforms, so this only ever costs anything in landscape.
			style={{
				paddingLeft: insets.left,
				paddingRight: insets.right
			}}
		>
			{children}
		</KeyboardAvoidingView>
	)
}

export default DomKeyboardHost
