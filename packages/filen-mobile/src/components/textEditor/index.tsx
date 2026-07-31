import { useRef, Fragment, useEffect, useState } from "react"
import TextEditorDOM from "@/components/textEditor/dom"
import RichTextEditorDOM, { type QuillFormats, type HeaderLevel } from "@/components/textEditor/richText/dom"
import { encodeEditorInitialValue } from "@/components/textEditor/initialValueCodec"
import View, { KeyboardAvoidingView } from "@/components/ui/view"
import { useNativeDomEvents, type DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import { AppState, Platform } from "react-native"
import { useNavigation } from "expo-router"
import { useResolveClassNames, useUniwind } from "uniwind"
import useRichtextStore from "@/stores/useRichtext.store"
import MarkdownPreviewButton from "@/components/textEditor/markdownPreviewButton"
import { useSecureStore } from "@/lib/secureStore"
import useTextEditorStore from "@/stores/useTextEditor.store"
import logger from "@/lib/logger"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import useChunkedWriteTarget from "@/hooks/useChunkedWriteTarget"
import { MAX_TEXT_BYTES } from "@/components/textEditor/constants"
import type { RangeReader } from "@/lib/rangeTransfer"
import type { File } from "expo-file-system"

export type TextEditorType = "richtext" | "text" | "markdown" | "code"

/** Outcome of loading a document in chunked mode. */
export type TextEditorDocumentStatus = "ready" | "notText" | "failed"

/**
 * How long to wait for the editor to answer a save request before giving up.
 *
 * Finite because the promise is awaited behind a touch-blocking modal: a WebView renderer killed
 * mid-serialisation never answers, and without this the app is unusable until it is force-quit.
 */
const SAVE_TIMEOUT_MS = 120000

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
			// Native → DOM: report the final document if it differs from the last value change
			// events delivered (see #67 — some WebView/keyboard combos never fire change events
			// for composed text). commitComposition additionally blurs the editor first so the
			// keyboard finalizes an in-flight composing region into the document — used when
			// the surface is going away anyway (screen pop / app background); the soft variant
			// (false) is safe while the user may keep typing (iOS inactive: notification shade,
			// app switcher — where a swipe-kill would never reach "background").
			type: "flushContent"
			data: {
				commitComposition: boolean
			}
	  }
	| {
			type: "externalLinkClicked"
			data: string
	  }
	// ── Chunked-document mode (drive file preview) ────────────────────────────
	// The document is pulled and pushed through bounded RPCs rather than carried in props and
	// messages, so these carry no content — only which document-sized thing happened.
	| {
			// DOM → native: the document now differs from what was loaded. Fired once.
			type: "contentEdited"
	  }
	| {
			// DOM → native: the document arrived and is in the editor.
			type: "documentLoaded"
	  }
	| {
			// DOM → native: the document will not be shown.
			type: "documentUnavailable"
			data: {
				reason: "notText" | "loadFailed"
			}
	  }
	| {
			// Native → DOM: stream the current document back through the write RPC.
			type: "writeDocument"
			data: {
				requestId: string
			}
	  }
	| {
			type: "documentWritten"
			data: {
				requestId: string
			}
	  }
	| {
			type: "documentWriteFailed"
			data: {
				requestId: string
			}
	  }

export type Colors = {
	text: {
		foreground: string
		muted: string
		primary: string
	}
	background: {
		primary: string
		// A neutral surface — the app's `bg-background-secondary`, not `bg-secondary`, which is the
		// indigo accent. The rich-text code block reads this.
		secondary: string
		// The indigo accent. Used where the editor needs a visible mark against the background rather
		// than a surface to sit on (the blockquote rule).
		accent: string
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
	fileName,
	autoFocus,
	readRange,
	fileSize,
	saveHandleRef,
	onDocumentEditedChange,
	onDocumentStatus,
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
	// Real filename of the previewed file, threaded to TextEditorDOM so it can pick the CodeMirror
	// language by extension (loadLanguage). Without it every code file defaults to "file.tsx" (TSX).
	fileName?: string
	autoFocus?: boolean
	/**
	 * Chunked-document mode, for previewing a file on disk rather than editing a note.
	 *
	 * Supplying `readRange` switches the editor over completely: the content is pulled through the
	 * reader instead of `initialValue`, changes are reported as a single `onDocumentEditedChange`
	 * signal instead of handing the whole document to `onValueChange` on every keystroke, and
	 * `saveHandleRef` streams it back out. Notes keep the plain-string path — their content comes
	 * from a query, not a file, and their sync genuinely needs every change.
	 *
	 * Deliberately flat rather than one grouped object: a grouped literal would change identity on
	 * every render of the host and re-run the effect that arms the save, discarding the temp file
	 * mid-save.
	 */
	readRange?: RangeReader
	fileSize?: number
	/** Filled with a function that streams the document into a temp file, or null when read-only. */
	saveHandleRef?: { current: (() => Promise<File | null>) | null }
	onDocumentEditedChange?: (edited: boolean) => void
	onDocumentStatus?: (status: TextEditorDocumentStatus) => void
	paddingTop?: number
	paddingBottom?: number
}) => {
	const ref = useRef<DOMRef>(null)
	const textForeground = useResolveClassNames("text-foreground")
	const textPrimary = useResolveClassNames("text-primary")
	const textMuted = useResolveClassNames("text-muted")
	const bgBackground = useResolveClassNames("bg-background")
	// The indigo accent. Kept for the blockquote mark only — see Colors.background.accent.
	const bgAccent = useResolveClassNames("bg-secondary")
	const bgSecondary = useResolveClassNames("bg-background-secondary")
	const text = useResolveClassNames("font-normal text-sm")
	const { theme } = useUniwind()
	const [textEditorMarkdownPreviewActive] = useSecureStore<Record<string, boolean>>("textEditorMarkdownPreviewActive", {})
	// Both halves of the source are required together, so one condition decides the mode everywhere.
	// A reader without a size would otherwise suppress `initialValue` while the DOM side stayed on the
	// plain-string path, and the editor would come up empty.
	const chunked = readRange !== undefined && fileSize !== undefined
	// Not sent at all in chunked mode: the point is that the document does not ride in a prop.
	const encodedInitialValue = useState(() => (chunked ? "" : encodeEditorInitialValue(initialValue ?? "")))[0]
	const writeTarget = useChunkedWriteTarget({
		maxBytes: MAX_TEXT_BYTES,
		fileName: "textSave.txt"
	})
	const writeResolverRef = useRef<((file: File | null) => void) | null>(null)
	const writeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const markdownPreviewActive = !id ? false : (textEditorMarkdownPreviewActive[id] ?? false)

	const openExternalLink = useOpenExternalLink("textEditor")

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
					// Vetted on THIS side of the bridge before opening. The WebView is the untrusted end
					// of it — note and markdown content can come from another user — so the scheme check
					// that ran there is only as trustworthy as the page that ran it. useOpenExternalLink
					// re-classifies and applies the same policy as every other untrusted link surface.
					openExternalLink(message.data).catch(err => {
						logger.error("textEditor", "failed to open an external link", { error: err })
					})

					break
				}

				case "contentEdited": {
					onDocumentEditedChange?.(true)

					break
				}

				case "documentLoaded": {
					onDocumentStatus?.("ready")

					break
				}

				case "documentUnavailable": {
					onDocumentStatus?.(message.data.reason === "notText" ? "notText" : "failed")

					break
				}

				case "documentWritten": {
					settleWrite(writeTarget.finish())

					break
				}

				case "documentWriteFailed": {
					logger.error("textEditor", "the editor could not serialise the document")

					writeTarget.discard()

					settleWrite(null)

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

	// Settles the in-flight save exactly once, whoever gets there first. The promise is awaited behind
	// a full-screen modal that blocks every touch and eats the Android back button, so a save that never
	// settles — a renderer killed mid-serialisation answers nothing — is an app the user must force-quit.
	const settleWrite = (file: File | null) => {
		if (writeTimeoutRef.current !== null) {
			clearTimeout(writeTimeoutRef.current)

			writeTimeoutRef.current = null
		}

		const resolve = writeResolverRef.current

		writeResolverRef.current = null

		resolve?.(file)
	}

	// Serialising happens inside the WebView, so the host asks for it through a message and settles the
	// promise when the editor reports back. Mirrors the PDF viewer's save.
	useEffect(() => {
		if (!saveHandleRef) {
			return
		}

		saveHandleRef.current = readOnly
			? null
			: () =>
					new Promise<File | null>(resolve => {
						// A save already in flight owns the write target; a second would re-arm it underneath
						// the first and strand this promise.
						if (writeResolverRef.current) {
							resolve(null)

							return
						}

						writeTarget.begin()

						writeResolverRef.current = resolve

						writeTimeoutRef.current = setTimeout(() => {
							logger.error("textEditor", "the editor did not answer the save request in time")

							writeTarget.discard()
							settleWrite(null)
						}, SAVE_TIMEOUT_MS)

						postMessageRef.current({
							type: "writeDocument",
							data: {
								requestId: `${Date.now()}`
							}
						})
					})

		return () => {
			saveHandleRef.current = null

			writeTarget.discard()
			settleWrite(null)
		}
	}, [readOnly, saveHandleRef, writeTarget])

	const navigation = useNavigation()

	// Belt for lost incremental change events (#67): ask the DOM side to commit any
	// in-flight IME composition and report the final document if it diverged from what
	// change events already delivered. Fired when the screen starts leaving (the WebView
	// survives through the pop animation — a teardown-time round trip would be too late)
	// and when the app backgrounds. Healthy devices emit nothing extra: the DOM side
	// only reports when its document differs from the last reported value.
	useEffect(() => {
		if (readOnly) {
			return
		}

		const unsubscribe = navigation.addListener("beforeRemove", () => {
			postMessageRef.current({
				type: "flushContent",
				data: {
					commitComposition: true
				}
			})
		})

		const appStateSubscription = AppState.addEventListener("change", state => {
			if (state === "background" || state === "inactive") {
				postMessageRef.current({
					type: "flushContent",
					data: {
						// Blur (keyboard dismissal) is only acceptable when the app is actually
						// going away — on iOS "inactive" also fires for the notification shade /
						// control center, where the user keeps typing right after.
						commitComposition: state === "background"
					}
				})
			}
		})

		return () => {
			unsubscribe()
			appStateSubscription.remove()
		}
	}, [navigation, readOnly])

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
								secondary: bgSecondary.backgroundColor as string,
								accent: bgAccent.backgroundColor as string
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
							fileName={fileName}
							markdownPreviewActive={markdownPreviewActive}
							autoFocus={autoFocus}
							// Top-level, never grouped: expo/dom only treats a top-level prop as a callable
							// action, so a nested function would be JSON-serialized away to undefined.
							readRange={chunked ? readRange : undefined}
							fileSize={chunked ? fileSize : undefined}
							writeChunk={chunked ? writeTarget.writeChunk : undefined}
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
									secondary: bgSecondary.backgroundColor as string,
									accent: bgAccent.backgroundColor as string
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
