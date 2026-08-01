import { KeyboardAvoidingView } from "@/components/ui/view"
import { cn } from "@filen/utils"

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
export const DomKeyboardHost = ({ children, className }: { children: React.ReactNode; className?: string }) => {
	return (
		<KeyboardAvoidingView
			className={cn("flex-1", className)}
			behavior="padding"
			automaticOffset={true}
		>
			{children}
		</KeyboardAvoidingView>
	)
}

export default DomKeyboardHost
