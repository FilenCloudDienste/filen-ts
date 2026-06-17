import { useRef, Fragment, useEffect, useState } from "react"
import TextEditorDOM from "@/components/textEditor/dom"
import RichTextEditorDOM, { type QuillFormats, type HeaderLevel } from "@/components/textEditor/richText/dom"
import { encodeEditorInitialValue } from "@/components/textEditor/initialValueCodec"
import View, { KeyboardAvoidingView } from "@/components/ui/view"
import { useNativeDomEvents, type DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import { Platform } from "react-native"
import { useResolveClassNames, useUniwind } from "uniwind"
import useRichtextStore from "@/stores/useRichtext.store"
import MarkdownPreviewButton from "@/components/textEditor/markdownPreviewButton"
import { useSecureStore } from "@/lib/secureStore"
import * as ExpoLinking from "expo-linking"
import alerts from "@/lib/alerts"
import useTextEditorStore from "@/stores/useTextEditor.store"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"

export type TextEditorType = "richtext" | "text" | "markdown" | "code"

export type TextEditorEvents =
	| {
			type: "quillFormats"
			data: QuillFormats
	  }
	| {
			type: "quillToggleBold"
	  }
	| {
			type: "dismissKeyboard"
	  }
	| {
			type: "quillToggleItalic"
	  }
	| {
			type: "quillToggleUnderline"
	  }
	| {
			type: "quillToggleHeader"
			data: HeaderLevel
	  }
	| {
			type: "quillRemoveLink"
	  }
	| {
			type: "quillAddLink"
			data: string
	  }
	| {
			type: "quillRemoveHeader"
	  }
	| {
			type: "quillToggleCodeBlock"
	  }
	| {
			type: "quillToggleBlockquote"
	  }
	| {
			type: "quillToggleList"
			data: "ordered" | "bullet" | "checklist"
	  }
	| {
			type: "quillRemoveList"
	  }
	| {
			type: "ready"
	  }
	| {
			type: "externalLinkClicked"
			data: string
	  }

export type Colors = {
	text: {
		foreground: string
		muted: string
		primary: string
	}
	background: {
		primary: string
		secondary: string
	}
}

export type Font = {
	weight?: number
	size?: number
	lineHeight?: number
	family?: string
}

export const backgroundColors = {
	normal: {
		light: Platform.select({
			ios: "#FFFFFF",
			default: "#FAFAFA"
		}),
		dark: Platform.select({
			ios: "#2A2A30",
			default: "#2E3236"
		})
	},
	markdown: {
		light: Platform.select({
			default: "#ffffff"
		}),
		dark: Platform.select({
			default: "#0d1118"
		})
	}
}

export const TextEditor = ({
	initialValue,
	onValueChange,
	placeholder,
	type,
	readOnly,
	onReady,
	disableMarkdownPreview,
	id,
	autoFocus,
	paddingTop,
	paddingBottom
}: {
	initialValue?: string
	onValueChange?: (value: string) => void
	placeholder?: string
	type: TextEditorType
	readOnly?: boolean
	onReady?: () => void
	disableMarkdownPreview?: boolean
	id?: string
	autoFocus?: boolean
	paddingTop?: number
	paddingBottom?: number
}) => {
	const ref = useRef<DOMRef>(null)
	const textForeground = useResolveClassNames("text-foreground")
	const textPrimary = useResolveClassNames("text-primary")
	const textMuted = useResolveClassNames("text-muted")
	const bgBackground = useResolveClassNames("bg-background")
	const bgSecondary = useResolveClassNames("bg-secondary")
	const text = useResolveClassNames("font-normal text-sm")
	const { theme } = useUniwind()
	const [textEditorMarkdownPreviewActive] = useSecureStore<Record<string, boolean>>("textEditorMarkdownPreviewActive", {})
	const encodedInitialValue = useState(() => encodeEditorInitialValue(initialValue ?? ""))[0]

	const markdownPreviewActive = !id ? false : (textEditorMarkdownPreviewActive[id] ?? false)

	const { onDomMessage, postMessage } = useNativeDomEvents<TextEditorEvents>({
		ref,
		onMessage: message => {
			switch (message.type) {
				case "quillFormats": {
					useRichtextStore.getState().setFormats(message.data)

					break
				}

				case "ready": {
					onReady?.()

					useTextEditorStore.getState().setReady(true)

					break
				}

				case "externalLinkClicked": {
					ExpoLinking.canOpenURL(message.data)
						.then(supported => {
							if (!supported) {
								alerts.error(i18n.t("cannot_open_link"))

								return
							}

							ExpoLinking.openURL(message.data).catch(err => {
								logger.error("textEditor", "openURL failed for external link", { error: err })
								alerts.error(err)
							})
						})
						.catch(err => {
							logger.error("textEditor", "canOpenURL failed for external link", { error: err })
							alerts.error(err)
						})

					break
				}
			}
		}
	})

	useEffect(() => {
		useTextEditorStore.getState().setReady(false)

		// Clear stale format state from any previous richtext editor instance
		// (the Zustand store is global so it survives mount/unmount). The new
		// editor's first selection-change event will repopulate with its own
		// current formats. Belt-and-suspenders cleanup on unmount so a stacked
		// editor behind this one can't read this editor's last format state.
		useRichtextStore.getState().setFormats({})

		return () => {
			useRichtextStore.getState().setFormats({})
		}
	}, [])

	// Expose a STABLE dispatch wrapper to the route's header so it can render
	// the rich-text toolbar inside the navigation bar. postMessage itself is
	// re-created every render (onMessage is an inline closure), so we keep
	// the latest in a ref and publish a single stable wrapper to the store.
	// Cleared on unmount to prevent stale-closure invocations.
	const postMessageRef = useRef(postMessage)

	useEffect(() => {
		postMessageRef.current = postMessage
	}, [postMessage])

	useEffect(() => {
		if (type !== "richtext" || readOnly) {
			return
		}

		const stableDispatch = (event: TextEditorEvents) => {
			postMessageRef.current(event)
		}

		useTextEditorStore.getState().setDispatch(stableDispatch)

		return () => {
			useTextEditorStore.getState().setDispatch(null)
		}
	}, [type, readOnly])

	return (
		<Fragment>
			<KeyboardAvoidingView className="flex-1">
				{type === "richtext" ? (
					<RichTextEditorDOM
						ref={ref}
						dom={{
							onMessage: onDomMessage,
							bounces: false
						}}
						onValueChange={onValueChange}
						darkMode={theme === "dark"}
						platform={Platform.OS}
						initialValue={encodedInitialValue}
						placeholder={placeholder}
						readOnly={readOnly}
						autoFocus={autoFocus}
						font={{
							family: text.fontFamily as string,
							size: text.fontSize as number,
							weight: text.fontWeight as number
						}}
						colors={{
							text: {
								foreground: textForeground.color as string,
								primary: textPrimary.color as string,
								muted: textMuted.color as string
							},
							background: {
								primary: bgBackground.backgroundColor as string,
								secondary: bgSecondary.backgroundColor as string
							}
						}}
						paddingTop={paddingTop}
						paddingBottom={paddingBottom}
					/>
				) : (
					<View
						className="flex-1"
						style={{
							backgroundColor:
								type === "text"
									? bgBackground.backgroundColor
									: backgroundColors[type === "markdown" && markdownPreviewActive ? "markdown" : "normal"][
											theme === "dark" ? "dark" : "light"
										]
						}}
					>
						<TextEditorDOM
							ref={ref}
							type={type}
							onValueChange={onValueChange}
							darkMode={theme === "dark"}
							platform={Platform.OS}
							initialValue={encodedInitialValue}
							placeholder={placeholder}
							readOnly={readOnly}
							markdownPreviewActive={markdownPreviewActive}
							autoFocus={autoFocus}
							dom={{
								onMessage: onDomMessage,
								bounces: false
							}}
							font={{
								family: text.fontFamily as string,
								size: text.fontSize as number,
								weight: text.fontWeight as number
							}}
							colors={{
								text: {
									foreground: textForeground.color as string,
									primary: textPrimary.color as string,
									muted: textMuted.color as string
								},
								background: {
									primary: bgBackground.backgroundColor as string,
									secondary: bgSecondary.backgroundColor as string
								}
							}}
							paddingTop={paddingTop}
							paddingBottom={paddingBottom}
						/>
					</View>
				)}
			</KeyboardAvoidingView>
			{!disableMarkdownPreview && type === "markdown" && <MarkdownPreviewButton id={id ?? "textEditor"} />}
		</Fragment>
	)
}

export default TextEditor
