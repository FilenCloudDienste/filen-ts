import Dom from "@/components/docxPreview/dom"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"
import type { WebViewMessageEvent } from "react-native-webview"

const DocxPreview = ({ base64, paddingTop, paddingBottom }: { base64: string; paddingTop?: number; paddingBottom?: number }) => {
	return (
		<Dom
			base64={base64}
			paddingTop={paddingTop}
			paddingBottom={paddingBottom}
			dom={{
				overScrollMode: "never",
				bounces: false,
				onMessage: (event: WebViewMessageEvent) => {
					// docxPreview is otherwise one-way; this only receives the WebView console proxy.
					try {
						forwardDomConsoleLog(JSON.parse(event.nativeEvent.data))
					} catch {
						// ignore malformed messages
					}
				}
			}}
		/>
	)
}

export default DocxPreview
