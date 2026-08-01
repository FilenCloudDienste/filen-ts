import Dom from "@/components/docxPreview/dom"
import DomKeyboardHost from "@/components/domKeyboardHost"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"
import { parseDocxExternalLink } from "@/components/docxPreview/linkSafety"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import type { WebViewMessageEvent } from "react-native-webview"
import type { RangeReader } from "@/lib/rangeTransfer"
import logger from "@/lib/logger"

const DocxPreview = ({
	readRange,
	fileSize,
	paddingTop,
	paddingBottom
}: {
	readRange: RangeReader
	fileSize: number
	paddingTop?: number
	paddingBottom?: number
}) => {
	const openExternalLink = useOpenExternalLink("docxPreview")

	return (
		<DomKeyboardHost>
			<Dom
				readRange={readRange}
				fileSize={fileSize}
				paddingTop={paddingTop}
				paddingBottom={paddingBottom}
				dom={{
					overScrollMode: "never",
					bounces: false,
					onMessage: (event: WebViewMessageEvent) => {
						// Two message kinds share this channel: the WebView console proxy, and a tap on a
						// link inside the rendered document. Each carries its own envelope key, so they are
						// demultiplexed rather than guessed at.
						try {
							const parsed: unknown = JSON.parse(event.nativeEvent.data)

							if (forwardDomConsoleLog(parsed)) {
								return
							}

							// Re-classified here rather than trusted: the WebView is the untrusted side of
							// this bridge. useOpenExternalLink then applies the same policy every other
							// untrusted link in the app goes through, including the trusted-domain prompt.
							const externalUrl = parseDocxExternalLink(parsed)

							if (externalUrl !== null) {
								openExternalLink(externalUrl).catch(err => {
									logger.error("docxPreview", "failed to open a document link", { error: err })
								})
							}
						} catch {
							// ignore malformed messages
						}
					}
				}}
			/>
		</DomKeyboardHost>
	)
}

export default DocxPreview
