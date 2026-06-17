import type { DOMImperativeFactory } from "expo/dom"
import type { WebViewMessageEvent } from "react-native-webview"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"

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
				// console.* (not the RN logger): part of the DOM-event bridge — kept on console with
				// useDomDomEvents until the deferred WebView-console-proxy work lands.
				console.error(e)
			}
		})()
	}

	const onDomMessage = (message: WebViewMessageEvent) => {
		let parsed: unknown

		try {
			parsed = JSON.parse(message.nativeEvent.data)
		} catch (e) {
			console.error(e)

			return
		}

		// Intercept WebView console-proxy envelopes → RN logger before the app handler sees them.
		if (forwardDomConsoleLog(parsed)) {
			return
		}

		if (!params.onMessage) {
			return
		}

		try {
			params.onMessage(parsed as T, postMessage)
		} catch (e) {
			console.error(e)
		}
	}

	return {
		onDomMessage,
		postMessage
	}
}
