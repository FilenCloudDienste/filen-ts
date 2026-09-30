import type { JSONValue } from "expo/build/dom/dom.types"
import { getReactNativeWebView } from "@/lib/domExternalLink"

function useDomDomEvents<T>(onMessage?: (message: T, postMessage: (message: T) => void) => void) {
	const postMessage = (message: T) => {
		const rnWebView = getReactNativeWebView()

		// console.* (NOT the RN logger): this runs inside the WebView, where the logger is unavailable.
		// domConsoleProxy forwards it to the native side.
		if (!rnWebView) {
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
