"use dom"

import { useRef, useState } from "react"
import { renderAsync } from "docx-preview"
import { Buffer } from "buffer"
import useEffectOnce from "@/hooks/useEffectOnce"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"

// Forward this WebView's console.* to the RN diagnostic logger (see domConsoleProxy).
installDomConsoleProxy()

// The DOM-component shell ships `user-scalable=no` in its viewport meta, which blocks
// pinch-zoom on both engines. Relax it for THIS component only — a document preview is
// expected to zoom like the PDF viewer does. Both WebKit and Chromium honor the runtime
// change, and other DOM components (the note editors) keep the shell's no-zoom default.
document
	.querySelector("meta[name=viewport]")
	?.setAttribute("content", "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5")

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

	// The browser consults touch-action for visual-viewport panning while pinch-zoomed too —
	// with an explicit pan list, a zoomed document can pan but not always fluidly diagonally.
	// Switch to fully unrestricted touch handling while zoomed (scale > 1) and restore the
	// declared pan/pinch set at 1x. Gesture claims latch at touch-start, so flipping between
	// gestures never glitches mid-pan.
	useEffectOnce(() => {
		const visualViewport = window.visualViewport

		if (!visualViewport) {
			return
		}

		const onResize = () => {
			if (!container.current) {
				return
			}

			container.current.style.touchAction = visualViewport.scale > 1.01 ? "auto" : "pan-y pan-x pinch-zoom"
		}

		visualViewport.addEventListener("resize", onResize)

		return () => {
			visualViewport.removeEventListener("resize", onResize)
		}
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
				// With inWrapper: false the library's white-page rule (.docx-wrapper>section.docx)
				// never applies, and documents without an explicit <w:background> render as black
				// text on a transparent page — invisible over the app's dark background. Paint the
				// paper ourselves; a document's own background color still layers on top.
				backgroundColor: "#ffffff",
				// Panning alone (pan-x/pan-y) suppresses browser pinch-zoom at the element
				// level — pinch-zoom must be explicitly re-allowed alongside it.
				touchAction: "pan-y pinch-zoom pan-x"
			}}
		/>
	)
}

export default Dom
