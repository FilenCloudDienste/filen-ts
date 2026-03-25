import { useRef, Fragment, useEffect, memo } from "react"
import TextEditorDOM from "@/components/textEditor/dom"
import RichTextEditorDOM, { type QuillFormats, type HeaderLevel } from "@/components/textEditor/richText/dom"
import View from "@/components/ui/view"
import { useNativeDomEvents, type DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import { Platform, KeyboardAvoidingView } from "react-native"
import { useResolveClassNames, useUniwind } from "uniwind"
import useRichtextStore from "@/stores/useRichtext.store"
import RichTextEditorToolbar from "@/components/textEditor/richText/toolbar"
import MarkdownPreviewButton from "@/components/textEditor/markdownPreviewButton"
import { useSecureStore } from "@/lib/secureStore"
import * as ExpoLinking from "expo-linking"
import alerts from "@/lib/alerts"
import useTextEditorStore from "@/stores/useTextEditor.store"

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

export const TextEditor = memo(
	({
		initialValue,
		onValueChange,
		placeholder,
		disableRichtextToolbar,
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
		disableRichtextToolbar?: boolean
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

						useRichtextStore.getState().setFormats({})
						useTextEditorStore.getState().setReady(true)

						break
					}

					case "externalLinkClicked": {
						ExpoLinking.canOpenURL(message.data)
							.then(supported => {
								if (!supported) {
									alerts.error(`No app found to open ${message.data}`)

									return
								}

								ExpoLinking.openURL(message.data).catch(err => {
									console.error(err)
									alerts.error(err)
								})
							})
							.catch(err => {
								console.error(err)
								alerts.error(err)
							})

						break
					}
				}
			}
		})

		useEffect(() => {
			useTextEditorStore.getState().setReady(false)
		}, [])

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
							initialValue={initialValue}
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
								initialValue={initialValue}
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
				{!disableRichtextToolbar && type === "richtext" && !readOnly && <RichTextEditorToolbar postMessage={postMessage} />}
				{!disableMarkdownPreview && type === "markdown" && <MarkdownPreviewButton id={id ?? "textEditor"} />}
			</Fragment>
		)
	}
)

export default TextEditor
