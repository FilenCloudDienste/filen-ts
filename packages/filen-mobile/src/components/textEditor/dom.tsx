"use dom"

import "@uiw/react-md-editor/markdown-editor.css"
import "@uiw/react-markdown-preview/markdown.css"

import { type DOMProps, useDOMImperativeHandle } from "expo/dom"
import { useEffect, useRef, useState } from "react"
import type { Platform } from "react-native"
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { xcodeLight, xcodeDark } from "@uiw/codemirror-theme-xcode"
import { materialDark, materialLight } from "@uiw/codemirror-theme-material"
import type { TextEditorType, Font, Colors, TextEditorEvents } from "@/components/textEditor"
import { createTextThemes, parseExtension, loadLanguage } from "@/components/textEditor/codeMirror"
import type { DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import useDomDomEvents from "@/hooks/useDomEvents/useDomDomEvents"
import MDEditor from "@uiw/react-md-editor"
import rehypeSanitize from "rehype-sanitize"
import { visit } from "unist-util-visit"
import type { Plugin } from "unified"
import type { Root, Element } from "hast"
import { memo, useCallback, useMemo } from "@/lib/memo"

const rehypeExternalLinks: Plugin<[], Root> = () => {
	return tree => {
		visit(tree, "element", (node: Element) => {
			try {
				if (node.tagName === "a" && node.properties?.["href"]) {
					const href = String(node.properties["href"]).trim().toLowerCase()
					const protocols = ["http://", "https://", "mailto:", "tel:", "sms:", "whatsapp:", "geo:", "maps:"]
					const shouldIntercept = protocols.some(protocol => href.startsWith(protocol))

					if (shouldIntercept) {
						node.properties["data-external-url"] = href
						node.properties["href"] = "#"
					}
				}
			} catch (e) {
				console.error(e)
			}
		})
	}
}

const TextEditorDOM = memo(
	({
		ref,
		initialValue,
		onValueChange,
		placeholder,
		darkMode,
		platform,
		readOnly,
		fileName,
		type,
		autoFocus,
		font,
		colors,
		markdownPreviewActive,
		paddingTop,
		paddingBottom
	}: {
		ref: React.Ref<DOMRef>
		dom?: DOMProps
		initialValue?: string
		onValueChange?: (value: string) => void
		placeholder?: string
		darkMode: boolean
		platform: Platform["OS"]
		readOnly?: boolean
		fileName?: string
		type: TextEditorType
		autoFocus?: boolean
		font?: Font
		colors?: Colors
		markdownPreviewActive?: boolean
		paddingTop?: number
		paddingBottom?: number
	}) => {
		const didTypeRef = useRef<boolean>(false)
		const [value, setValue] = useState<string>(initialValue ?? "")
		const codeMirrorRef = useRef<ReactCodeMirrorRef>(null)

		const onChange = useCallback(
			(value: string) => {
				if (!didTypeRef.current) {
					return
				}

				onValueChange?.(value)
				setValue(value)
			},
			[onValueChange]
		)

		const isTextFile = useMemo(() => {
			return type === "text" || parseExtension(fileName ?? "file.tsx") === ".txt"
		}, [fileName, type])

		const theme = useMemo(() => {
			if (isTextFile) {
				const textThemes = createTextThemes({
					backgroundColor: colors?.background?.primary ?? (darkMode ? "#0d1118" : "#ffffff"),
					textForegroundColor: colors?.text?.foreground ?? (darkMode ? "#c9d1d9" : "#24292e")
				})

				return textThemes[platform === "ios" ? "macOS" : "linux"][darkMode ? "dark" : "light"]
			}

			return platform === "android" ? (darkMode ? materialDark : materialLight) : darkMode ? xcodeDark : xcodeLight
		}, [darkMode, platform, isTextFile, colors])

		const extensions = useMemo(() => {
			const base = [
				EditorView.lineWrapping,
				EditorView.theme({
					"&": {
						outline: "none !important",
						fontSize: type === "text" ? `${font?.size ?? 16}px !important` : `${font?.size ?? 14}px !important`,
						// eslint-disable-next-line quotes
						fontFamily: `${font?.family ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'} !important`,
						padding: type === "text" ? "16px" : "0px",
						...(paddingTop
							? {
									paddingTop: `${paddingTop}px`
								}
							: {}),
						...(paddingBottom
							? {
									paddingBottom: `${paddingBottom}px`
								}
							: {})
					},
					"&.cm-focused": {
						outline: "none !important",
						border: "none !important",
						boxShadow: "none !important"
					},
					"&:focus-visible": {
						outline: "none !important"
					},
					...(isTextFile
						? {
								".cm-gutters": {
									display: "none !important"
								},
								".cm-line": {
									lineHeight: `${font?.lineHeight ?? 1.5} !important`,
									fontSize: type === "text" ? `${font?.size ?? 16}px !important` : `${font?.size ?? 14}px !important`,
									fontFamily: `${font?.family ?? "inherit"} !important`
								}
							}
						: {
								".cm-gutters": {
									fontSize: type === "text" ? `${font?.size ?? 16}px !important` : `${font?.size ?? 14}px !important`,
									fontFamily: `${font?.family ?? "inherit"} !important`
								},
								".cm-line": {
									fontSize: type === "text" ? `${font?.size ?? 16}px !important` : `${font?.size ?? 14}px !important`,
									fontFamily: `${font?.family ?? "inherit"} !important`
								}
							})
				})
			]

			const lang = loadLanguage(fileName ?? "file.tsx")

			if (isTextFile || !lang) {
				return base
			}

			return [...base, lang]
		}, [isTextFile, fileName, font, type, paddingTop, paddingBottom])

		const { onNativeMessage, postMessage } = useDomDomEvents<TextEditorEvents>()

		useDOMImperativeHandle(
			ref,
			() => ({
				postMessage: onNativeMessage
			}),
			[]
		)

		useEffect(() => {
			postMessage({
				type: "ready"
			})

			const keydownListener = () => {
				didTypeRef.current = true
			}

			const onClickListener = (e: PointerEvent) => {
				if (!(e.target instanceof HTMLElement)) {
					return
				}

				const link = e.target.closest("a[data-external-url]")

				if (!link) {
					return
				}

				const url = link.getAttribute("data-external-url")?.toLowerCase().trim()

				if (!url) {
					return
				}

				postMessage({
					type: "externalLinkClicked",
					data: url
				})
			}

			window.addEventListener("keydown", keydownListener)
			window.addEventListener("click", onClickListener)

			return () => {
				window.removeEventListener("keydown", keydownListener)
				window.removeEventListener("click", onClickListener)
			}
		}, [postMessage])

		if (markdownPreviewActive && type === "markdown") {
			return (
				<div
					style={{
						overflowX: "hidden",
						overflowY: "auto",
						width: "100dvw",
						height: "100dvh",
						touchAction: "pan-y"
					}}
				>
					<MDEditor.Markdown
						source={value}
						data-color-mode={darkMode ? "dark" : "light"}
						rehypePlugins={[rehypeSanitize, rehypeExternalLinks]}
						style={{
							fontSize: font?.size ?? 14,
							fontFamily: font?.family ?? "inherit",
							lineHeight: font?.lineHeight ? font.lineHeight : 1.5,
							paddingLeft: 16,
							paddingRight: 16,
							border: "none",
							borderRadius: 0,
							...(paddingTop
								? {
										paddingTop
									}
								: {
										paddingTop: 16
									}),
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

		return (
			<CodeMirror
				ref={codeMirrorRef}
				value={initialValue}
				width="100dvw"
				onChange={onChange}
				extensions={extensions}
				readOnly={readOnly}
				placeholder={placeholder}
				indentWithTab={true}
				theme={theme}
				autoCapitalize="off"
				autoCorrect="off"
				autoSave="off"
				spellCheck={false}
				autoFocus={autoFocus}
				style={{
					width: "100dvw",
					touchAction: "pan-y"
				}}
			/>
		)
	}
)

export default TextEditorDOM
