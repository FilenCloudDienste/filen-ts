"use dom"

import "quill/dist/quill.snow.css"

import { type DOMProps, useDOMImperativeHandle } from "expo/dom"
import { useEffect, useRef, memo, useCallback } from "react"
import type { DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import useDomDomEvents from "@/hooks/useDomEvents/useDomDomEvents"
import Quill from "quill"
import DOMPurify from "dompurify"
import QuillThemeCustomizer, { getThemeOptions } from "@/components/textEditor/richText/quillTheme"
import type { Platform } from "react-native"
import type { TextEditorEvents, Colors, Font } from "@/components/textEditor"

DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
	if (node.tagName === "A" && node.getAttribute("href")) {
		node.setAttribute("target", "_blank")
		node.setAttribute("rel", "noopener noreferrer")
	}
})

export type HeaderLevel = 1 | 2 | 3 | 4 | 5 | 6
export type ListType = "ordered" | "bullet" | "checked" | "unchecked"
export type ScriptType = "sub" | "super"

export type QuillFormats = {
	header?: HeaderLevel
	bold?: boolean
	italic?: boolean
	underline?: boolean
	"code-block"?: "plain"
	link?: string
	blockquote?: boolean
	list?: ListType
	indent?: number
	script?: ScriptType
	direction?: "rtl" | "ltr"
	align?: "right" | "left" | "center"
}

const RichTextEditorDom = memo(
	({
		ref,
		initialValue,
		onValueChange,
		placeholder,
		darkMode,
		platform,
		readOnly,
		colors,
		font,
		autoFocus,
		paddingTop,
		paddingBottom
	}: {
		dom?: DOMProps
		ref: React.Ref<DOMRef>
		initialValue?: string
		onValueChange?: (value: string) => void
		placeholder?: string
		darkMode: boolean
		platform: Platform["OS"]
		readOnly?: boolean
		colors: Colors
		font?: Font
		autoFocus?: boolean
		paddingTop?: number
		paddingBottom?: number
	}) => {
		const quillRef = useRef<Quill | null>(null)
		const editorRef = useRef<HTMLDivElement | null>(null)
		const didTypeRef = useRef<boolean>(false)
		const quillThemeRef = useRef<QuillThemeCustomizer | null>(null)
		const quillFormatsRef = useRef<QuillFormats>({})

		const postFormatUpdates = useCallback((postMessage: (message: TextEditorEvents) => void) => {
			if (!quillRef.current) {
				return
			}

			const range = quillRef.current.getSelection()

			if (!range) {
				return
			}

			const formats = quillRef.current.getFormat(range)

			quillFormatsRef.current = formats

			postMessage({
				type: "quillFormats",
				data: formats
			})
		}, [])

		const { onNativeMessage, postMessage } = useDomDomEvents<TextEditorEvents>((message, postMessage) => {
			if (!quillRef.current) {
				return
			}

			didTypeRef.current = true

			switch (message.type) {
				case "quillToggleBold": {
					const isBold = quillFormatsRef.current.bold

					quillRef.current.format("bold", !isBold, "user")

					break
				}

				case "quillToggleItalic": {
					const isItalic = quillFormatsRef.current.italic

					quillRef.current.format("italic", !isItalic, "user")

					break
				}

				case "quillToggleUnderline": {
					const isUnderline = quillFormatsRef.current.underline

					quillRef.current.format("underline", !isUnderline, "user")

					break
				}

				case "quillToggleHeader": {
					const currentHeader = quillFormatsRef.current.header
					const newHeader = message.data === currentHeader ? undefined : message.data

					quillRef.current.format("header", newHeader, "user")

					break
				}

				case "quillToggleCodeBlock": {
					const isCodeBlock = quillFormatsRef.current["code-block"]
					const newCodeBlock = isCodeBlock ? false : "plain"

					quillRef.current.format("code-block", newCodeBlock, "user")

					break
				}

				case "quillToggleBlockquote": {
					const isBlockquote = quillFormatsRef.current.blockquote

					quillRef.current.format("blockquote", !isBlockquote, "user")

					break
				}

				case "quillToggleList": {
					const currentList = quillFormatsRef.current.list
					let newList: ListType | false

					if (
						(message.data === "ordered" && currentList === "ordered") ||
						(message.data === "bullet" && currentList === "bullet") ||
						(message.data === "checklist" && (currentList === "checked" || currentList === "unchecked"))
					) {
						newList = false
					} else {
						if (message.data === "checklist") {
							newList = "unchecked"
						} else {
							newList = message.data
						}
					}

					quillRef.current.format("list", newList, "user")

					break
				}

				case "quillRemoveList": {
					quillRef.current.format("list", false, "user")

					break
				}

				case "quillRemoveHeader": {
					quillRef.current.format("header", false, "user")

					break
				}

				case "quillAddLink": {
					quillRef.current.format("link", message.data, "user")

					break
				}

				case "quillRemoveLink": {
					quillRef.current.format("link", false, "user")

					break
				}

				case "dismissKeyboard": {
					quillRef.current?.blur()

					break
				}
			}

			postFormatUpdates(postMessage)
		})

		useDOMImperativeHandle(
			ref,
			() => ({
				postMessage: onNativeMessage
			}),
			[]
		)

		useEffect(() => {
			const listener = () => {
				didTypeRef.current = true
			}

			window.addEventListener("keydown", listener)

			return () => {
				window.removeEventListener("keydown", listener)
			}
		}, [])

		useEffect(() => {
			if (!editorRef.current || quillRef.current) {
				return
			}

			quillRef.current = new Quill(editorRef.current, {
				modules: {
					toolbar: false
				},
				placeholder,
				theme: "snow"
			})

			quillRef.current.on("text-change", () => {
				postFormatUpdates(postMessage)

				if (!quillRef.current || !didTypeRef.current) {
					return
				}

				onValueChange?.(quillRef.current.root.innerHTML)
			})

			quillRef.current.on("selection-change", () => {
				postFormatUpdates(postMessage)
			})
		}, [placeholder, onValueChange, postFormatUpdates, postMessage])

		useEffect(() => {
			if (!editorRef.current || !quillRef.current) {
				return
			}

			if (quillThemeRef.current) {
				quillThemeRef.current.removeExistingStyles()
			}

			quillThemeRef.current = new QuillThemeCustomizer(
				getThemeOptions({
					darkMode,
					colors,
					platform,
					readOnly: readOnly ?? false,
					font
				})
			)

			quillThemeRef.current.apply(quillRef.current, editorRef.current?.id)
		}, [darkMode, platform, readOnly, colors, font])

		useEffect(() => {
			if (!quillRef.current) {
				return
			}

			if (initialValue) {
				const sanitized = DOMPurify.sanitize(initialValue, {
					ALLOWED_TAGS: [
						"p",
						"strong",
						"em",
						"u",
						"a",
						"h1",
						"h2",
						"h3",
						"h4",
						"h5",
						"h6",
						"code",
						"ol",
						"ul",
						"li",
						"blockquote",
						"pre",
						"br",
						"span",
						"div"
					],
					ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "class", "style"]
				})

				quillRef.current.clipboard.dangerouslyPasteHTML(sanitized, "silent")

				if (autoFocus) {
					quillRef.current.setSelection(sanitized.length, 0)
					quillRef.current.focus()
				}
			}
		}, [initialValue, autoFocus])

		useEffect(() => {
			postMessage({
				type: "ready"
			})
		}, [postMessage])

		return (
			<div
				style={{
					backgroundColor: "transparent",
					display: "flex",
					flex: 1,
					flexDirection: "column",
					touchAction: "pan-y"
				}}
			>
				<div
					ref={editorRef}
					style={{
						display: "flex",
						flex: 1,
						...(paddingTop
							? {
									paddingTop
								}
							: {}),
						...(paddingBottom
							? {
									paddingBottom
								}
							: {})
					}}
				/>
			</div>
		)
	}
)

export default RichTextEditorDom
