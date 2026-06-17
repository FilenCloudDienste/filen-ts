import type { JSONValue } from "expo/build/dom/dom.types"

export type RNWebViewFunctions = {
	postMessage?: ((message: unknown) => void) | undefined
}

function useDomDomEvents<T>(onMessage?: (message: T, postMessage: (message: T) => void) => void) {
	const postMessage = (message: T) => {
		const rnWebView = (globalThis as unknown as { ReactNativeWebView?: RNWebViewFunctions | undefined }).ReactNativeWebView

		// NOTE: keep console.* (NOT the RN logger) here — this runs inside the WebView/DOM context,
		// where the RN diagnostic logger is unavailable. Capturing DOM-side console is a separate
		// deferred effort (proxy DOM console → Hermes).
		if (!rnWebView || !rnWebView.postMessage) {
			console.error("RNWebView is not available")

			return
		}

		try {
			rnWebView.postMessage(JSON.stringify(message))
		} catch (e) {
			console.error(e)
		}
	}

	const onNativeMessage = (message: JSONValue) => {
		onMessage?.(message as T, postMessage)
	}

	return {
		postMessage,
		onNativeMessage
	}
}

export default useDomDomEvents
