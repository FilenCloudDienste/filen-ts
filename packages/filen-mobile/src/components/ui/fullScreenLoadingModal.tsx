import { useState, useEffect, memo } from "react"
import { Modal, ActivityIndicator, Platform, type NativeSyntheticEvent } from "react-native"
import { run, type DeferFn, type Result, type Options, runEffect } from "@filen/utils"
import { FullWindowOverlay } from "react-native-screens"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import events from "@/lib/events"

const FullScreenLoadingModalParent = memo(({ children, visible }: { children: React.ReactNode; visible: boolean }) => {
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
				className="z-9999"
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
})

export const FullScreenLoadingModal = memo(() => {
	const [count, setCount] = useState<number>(0)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const showFullScreenLoadingModalListener = events.subscribe("showFullScreenLoadingModal", () => {
				setCount(prev => prev + 1)
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
				setCount(0)
			})

			defer(() => {
				forceHideFullScreenLoadingModalListener.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	return (
		<FullScreenLoadingModalParent visible={count > 0}>
			<AnimatedView
				className="flex-1 bg-black/50 justify-center items-center top-0 left-0 right-0 bottom-0 z-9999 w-full h-full absolute"
				entering={FadeIn}
				exiting={FadeOut}
			>
				<ActivityIndicator
					size="large"
					className="text-foreground"
				/>
			</AnimatedView>
		</FullScreenLoadingModalParent>
	)
})

export function forceHide(): void {
	events.emit("forceHideFullScreenLoadingModal")
}

export async function runWithLoading<TResult, E = unknown>(
	fn: (defer: DeferFn, hideLoader?: () => void) => TResult | Promise<TResult>,
	options?: Options
): Promise<Result<TResult, E>> {
	return await run<TResult, E>(async defer => {
		events.emit("showFullScreenLoadingModal")

		defer(() => {
			events.emit("hideFullScreenLoadingModal")
		})

		return await fn(defer, () => {
			events.emit("hideFullScreenLoadingModal")
		})
	}, options)
}

export default FullScreenLoadingModal
