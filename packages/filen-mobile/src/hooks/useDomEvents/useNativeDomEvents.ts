import type { DOMImperativeFactory } from "expo/dom"
import type { WebViewMessageEvent } from "react-native-webview"

export interface DOMRef extends DOMImperativeFactory {
	postMessage: (message: unknown) => void
}

export function useNativeDomEvents<T>(params: {
	onMessage?: (message: T, postMessage: (message: T) => void) => void
	ref: React.RefObject<DOMRef | null>
}) {
	const postMessage = (message: T) => {
		;(async () => {
			let attempts = 0

			while (!params.ref.current && attempts < 100) {
				await new Promise<void>(resolve => setTimeout(resolve, 100))

				attempts++
			}

			if (!params.ref.current) {
				return
			}

			try {
				params.ref.current.postMessage(message)
			} catch (e) {
				console.error(e)
			}
		})()
	}

	const onDomMessage = (message: WebViewMessageEvent) => {
		if (!params.onMessage) {
			return
		}

		try {
			params.onMessage(JSON.parse(message.nativeEvent.data) as T, postMessage)
		} catch (e) {
			console.error(e)
		}
	}

	return {
		onDomMessage,
		postMessage
	}
}
