import { useLayoutEffect, useRef, useState } from "react"
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
	const paramsRef = useRef(params)

	useLayoutEffect(() => {
		paramsRef.current = params
	})

	// Stable identities: expo/dom re-sends every prop over the bridge whenever the DOM element changes,
	// so fresh handlers per render would re-inject the whole payload (a note's full seed) each time.
	return useState(() => {
		const postMessage = (message: T) => {
			;(async () => {
				let attempts = 0

				while (!paramsRef.current.ref.current && attempts < 100) {
					await new Promise<void>(resolve => setTimeout(resolve, 100))

					attempts++
				}

				if (!paramsRef.current.ref.current) {
					return
				}

				try {
					paramsRef.current.ref.current.postMessage(message)
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

			if (!paramsRef.current.onMessage) {
				return
			}

			try {
				paramsRef.current.onMessage(parsed as T, postMessage)
			} catch (e) {
				console.error(e)
			}
		}

		return {
			onDomMessage,
			postMessage
		}
	})[0]
}
