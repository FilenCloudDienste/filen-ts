"use dom"

import { useRef, useState } from "react"
import { renderAsync } from "docx-preview"
import { Buffer } from "buffer"
import useEffectOnce from "@/hooks/useEffectOnce"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"

// Forward this WebView's console.* to the RN diagnostic logger (see domConsoleProxy).
installDomConsoleProxy()

const Dom = ({
	base64,
	paddingTop,
	paddingBottom
}: {
	dom?: import("expo/dom").DOMProps
	base64: string
	paddingTop?: number
	paddingBottom?: number
}) => {
	const container = useRef<HTMLDivElement>(null)
	const didLoadRef = useRef<boolean>(false)
	const [error, setError] = useState<string | null>(null)

	const load = async () => {
		if (!container.current || didLoadRef.current) {
			return
		}

		didLoadRef.current = true

		try {
			await renderAsync(Buffer.from(base64, "base64"), container.current, container.current, {
				ignoreHeight: true,
				ignoreWidth: true,
				ignoreFonts: false,
				breakPages: true,
				debug: false,
				experimental: true,
				inWrapper: false,
				trimXmlDeclaration: true,
				ignoreLastRenderedPageBreak: true,
				renderHeaders: true,
				renderFooters: true,
				renderFootnotes: true,
				useBase64URL: true,
				renderEndnotes: true,
				// Alt-chunks embed foreign HTML/RTF sub-documents carried inside the file itself. They're
				// rare in real documents and already disabled on the web and desktop clients — keep mobile
				// consistent and don't render embedded content from the document.
				renderAltChunks: false,
				renderChanges: true,
				renderComments: true,
				hideWrapperOnPrint: false
			})
		} catch (e) {
			console.error(e)

			didLoadRef.current = false
			setError("Failed to render document")
		}
	}

	useEffectOnce(() => {
		load()
	})

	if (error !== null) {
		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					paddingTop: paddingTop ? `${paddingTop}px` : undefined,
					paddingBottom: paddingBottom ? `${paddingBottom}px` : undefined
				}}
			>
				<span style={{ color: "#888", fontSize: "14px" }}>{error}</span>
			</div>
		)
	}

	return (
		<div
			ref={container}
			style={{
				width: "100%",
				height: "100%",
				overflow: "auto",
				paddingTop: paddingTop ? `${paddingTop}px` : undefined,
				paddingBottom: paddingBottom ? `${paddingBottom}px` : undefined,
				touchAction: "pan-y"
			}}
		/>
	)
}

export default Dom
