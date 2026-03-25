import type { JSONValue } from "expo/build/dom/dom.types"

export type RNWebViewFunctions = {
	postMessage?: ((message: unknown) => void) | undefined
}

const RNWebView = (
	globalThis as unknown as {
		ReactNativeWebView?: RNWebViewFunctions | undefined
	}
).ReactNativeWebView

function useDomDomEvents<T>(onMessage?: (message: T, postMessage: (message: T) => void) => void) {
	const postMessage = (message: T) => {
		if (!RNWebView || !RNWebView.postMessage) {
			console.error("RNWebView is not available")

			return
		}

		try {
			RNWebView.postMessage(JSON.stringify(message))
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
