import { useState, useEffect } from "react"
import { Modal, ActivityIndicator, Platform, type NativeSyntheticEvent } from "react-native"
import { run, type DeferFn, type Result, type Options, runEffect } from "@filen/utils"
import { FullWindowOverlay } from "react-native-screens"
import { FadeIn } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import events from "@/lib/events"

const FullScreenLoadingModalParent = ({ children, visible }: { children: React.ReactNode; visible: boolean }) => {
	const onRequestClose = (e: NativeSyntheticEvent<unknown>) => {
		e.preventDefault()
		e.stopPropagation()
	}

	if (Platform.OS === "ios" && !visible) {
		return null
	}

	return Platform.select({
		ios: <FullWindowOverlay>{children}</FullWindowOverlay>,
		default: (
			<Modal
				className="z-99999"
				visible={visible}
				transparent={true}
				animationType="none"
				presentationStyle="overFullScreen"
				onRequestClose={onRequestClose}
				statusBarTranslucent={true}
				navigationBarTranslucent={true}
				allowSwipeDismissal={false}
			>
				{children}
			</Modal>
		)
	})
}

// How long the overlay lingers after the show-counter reaches 0 before the native presentation is
// dismissed. Both native containers (Android Modal, iOS FullWindowOverlay) present asynchronously:
// flipping `visible` back to false while the native show is still mid-flight can swallow the
// dismiss — and since React never re-sends an unchanged prop, the overlay then stays up FOREVER
// (stuck spinner, app unusable until restart). Lingering guarantees the presentation has settled
// before it is dismissed, and coalesces back-to-back operations into one continuous presentation
// instead of rapid native show/dismiss churn. Showing stays instant so input is blocked immediately.
const HIDE_LINGER_MS = 150

export const FullScreenLoadingModal = () => {
	const [count, setCount] = useState<number>(0)
	const [lingering, setLingering] = useState<boolean>(false)

	// The linger window only counts down while no operation is active; a new show re-arms it
	// (the timeout is cleared via the effect cleanup when `count` changes), so back-to-back
	// operations keep one continuous native presentation alive instead of churning show/dismiss.
	useEffect(() => {
		if (count > 0 || !lingering) {
			return
		}

		const timeout = setTimeout(() => {
			setLingering(false)
		}, HIDE_LINGER_MS)

		return () => {
			clearTimeout(timeout)
		}
	}, [count, lingering])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const showFullScreenLoadingModalListener = events.subscribe("showFullScreenLoadingModal", () => {
				setCount(prev => Math.max(0, prev + 1))
				// Armed here (not derived in an effect) so `visible` is true from the very first
				// commit and stays true through the post-completion linger window.
				setLingering(true)
			})

			defer(() => {
				showFullScreenLoadingModalListener.remove()
			})

			const hideFullScreenLoadingModalListener = events.subscribe("hideFullScreenLoadingModal", () => {
				setCount(prev => Math.max(0, prev - 1))
			})

			defer(() => {
				hideFullScreenLoadingModalListener.remove()
			})

			const forceHideFullScreenLoadingModalListener = events.subscribe("forceHideFullScreenLoadingModal", () => {
				// The recovery escape hatch dismisses immediately — no linger.
				setCount(0)
				setLingering(false)
			})

			defer(() => {
				forceHideFullScreenLoadingModalListener.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	// Deliberately NO `exiting` animation: reanimated exit animations defer the native removal of
	// the removed subtree until the animation completes, and inside a FullWindowOverlay (a separate
	// window-level container on iOS) that completion can get lost — leaving the full-screen,
	// touch-intercepting overlay attached FOREVER (stuck spinner, app unusable until restart).
	// The mount fade-in is safe; hiding is instant by design (after the linger window above).
	return (
		<FullScreenLoadingModalParent visible={count > 0 || lingering}>
			<AnimatedView
				className="flex-1 bg-black/50 justify-center items-center top-0 left-0 right-0 bottom-0 z-9999 w-full h-full absolute"
				entering={FadeIn}
			>
				<ActivityIndicator
					size="large"
					className="text-foreground"
				/>
			</AnimatedView>
		</FullScreenLoadingModalParent>
	)
}

export function forceHide(): void {
	events.emit("forceHideFullScreenLoadingModal")
}

export async function runWithLoading<TResult, E = unknown>(
	fn: (defer: DeferFn, hideLoader?: () => void) => TResult | Promise<TResult>,
	options?: Options
): Promise<Result<TResult, E>> {
	return await run<TResult, E>(async defer => {
		events.emit("showFullScreenLoadingModal")

		let hidden = false

		const hide = () => {
			if (hidden) {
				return
			}

			hidden = true

			events.emit("hideFullScreenLoadingModal")
		}

		defer(() => {
			hide()
		})

		return await fn(defer, hide)
	}, options)
}

export default FullScreenLoadingModal
