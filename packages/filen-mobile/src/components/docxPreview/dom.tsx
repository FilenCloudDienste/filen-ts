"use dom"

import { useRef, useCallback } from "react"
import { renderAsync } from "docx-preview"
import { Buffer } from "buffer"
import { memo } from "@/lib/memo"
import useEffectOnce from "@/hooks/useEffectOnce"

const Dom = memo(
	({
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

		const load = useCallback(async () => {
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
					renderAltChunks: true,
					renderChanges: true,
					renderComments: true,
					hideWrapperOnPrint: false
				})
			} catch (e) {
				console.error(e)

				didLoadRef.current = false
			}
		}, [base64])

		useEffectOnce(() => {
			load()
		})

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
)

export default Dom
