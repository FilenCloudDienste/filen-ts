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
import useEffectOnce from "@/hooks/useEffectOnce"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"
import { decodeEditorInitialValue } from "@/components/textEditor/initialValueCodec"
import { classifyExternalLinkHref } from "@/components/textEditor/linkUtils"
import { readAllText, writeAllBytes, type ChunkWriter, type RangeReader } from "@/lib/rangeTransfer"
import { isProbablyBinaryText } from "@/lib/previewType"
import MDEditor from "@uiw/react-md-editor"
import rehypeSanitize from "rehype-sanitize"
import { visit } from "unist-util-visit"
import type { Plugin } from "unified"
import type { Root, Element } from "hast"

// Forward this WebView's console.* to the RN diagnostic logger (see domConsoleProxy).
installDomConsoleProxy()

const rehypeExternalLinks: Plugin<[], Root> = () => {
	return tree => {
		visit(tree, "element", (node: Element) => {
			try {
				if (node.tagName === "a" && node.properties?.["href"]) {
					const { url, intercept } = classifyExternalLinkHref(String(node.properties["href"]))

					if (intercept) {
						node.properties["data-external-url"] = url
						node.properties["href"] = "#"
					}
				}
			} catch (e) {
				console.error(e)
			}
		})
	}
}

// How long after a flush request (and its optional composition-committing blur) the document
// is re-read for the divergence check — long enough for the keyboard's finalized text to land
// through the normal DOM event path, short enough to fit inside a screen-pop animation.
const FLUSH_COMPOSITION_COMMIT_MS = 80

const TextEditorDOM = ({
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
	readRange,
	fileSize,
	writeChunk,
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
	// Chunked-document mode, used for previewing a file on disk. These three MUST stay top-level
	// props: expo/dom only recognises a function as a callable action when it is a top-level prop, so
	// grouping them into an object would silently JSON-serialize them away to undefined.
	readRange?: RangeReader
	fileSize?: number
	writeChunk?: ChunkWriter
	paddingTop?: number
	paddingBottom?: number
}) => {
	const [value, setValue] = useState<string>(() => decodeEditorInitialValue(initialValue ?? ""))
	const codeMirrorRef = useRef<ReactCodeMirrorRef>(null)
	// Chunked mode reports only that the document changed, never the document itself — see onChange.
	const chunked = readRange !== undefined && fileSize !== undefined
	const editedReportedRef = useRef<boolean>(false)

	// Latest-props refs for the flush handler: the imperative message handler is captured once
	// per WebView mount ([] deps on useDOMImperativeHandle), so it must read everything through
	// refs to stay current.
	const onValueChangeRef = useRef(onValueChange)
	const readOnlyRef = useRef(readOnly)
	const writeChunkRef = useRef(writeChunk)

	useEffect(() => {
		onValueChangeRef.current = onValueChange
		readOnlyRef.current = readOnly
		writeChunkRef.current = writeChunk
	})

	// The last document value delivered to native — by a change event or a flush. The flush
	// path only emits when the live document DIFFERS from this, so on devices where change
	// events work (everywhere but #67's) flushes are pure no-ops.
	const lastReportedValueRef = useRef(decodeEditorInitialValue(initialValue ?? ""))

	// #39 fix: do NOT gate propagation on a physical keydown. `@uiw/react-codemirror`
	// already filters out programmatic/initial `setValue` changes (it only fires
	// onChange for real document mutations), so the old `didTypeRef` keydown gate was
	// redundant and silently dropped paste / voice-dictation / autocomplete inserts
	// (which emit no keydown). `setValue` keeps the controlled value in sync.
	const onChange = (value: string) => {
		setValue(value)

		// Chunked mode reports that the document changed, never WHAT it changed to. The document
		// crosses this bridge as a JSON string inside a postMessage, so sending it on every keystroke
		// makes typing cost the file size per character. The host pulls it once, when the user saves.
		if (chunked) {
			if (!editedReportedRef.current) {
				editedReportedRef.current = true

				postMessageRef.current({
					type: "contentEdited"
				})
			}

			return
		}

		lastReportedValueRef.current = value

		onValueChange?.(value)
	}

	// #67: some WebView/keyboard combos (seen on hardened Android WebViews) never deliver
	// change events for IME-composed text — the document (or the composing region) diverges
	// from what native has seen, and navigating away loses it. On request: optionally blur
	// (forcing the keyboard to finalize the composing region into the document through the
	// normal event path), then report the document iff it differs from the last reported
	// value. setValue keeps the controlled prop aligned so the update can't be reverted.
	// `post` is threaded in rather than read from postMessageRef because this runs from the native
	// message handler, and that handler is an argument to useDomDomEvents — the ref is written after
	// that call, which the compiler rejects. useDomDomEvents hands the handler its own postMessage for
	// exactly this, and it is stateless, so any render's copy stays correct.
	const flushPendingContent = (commitComposition: boolean, post: (message: TextEditorEvents) => void) => {
		if (readOnlyRef.current) {
			return
		}

		const view = codeMirrorRef.current?.view

		if (!view) {
			return
		}

		if (commitComposition) {
			view.contentDOM.blur()
		}

		setTimeout(() => {
			const doc = codeMirrorRef.current?.view?.state.doc.toString()

			if (doc === undefined || doc === lastReportedValueRef.current) {
				return
			}

			lastReportedValueRef.current = doc

			setValue(doc)

			// In chunked mode the document is never reported, only the fact that it changed — but a
			// divergence found HERE is the one case where a change event never fired, so without this
			// an IME-composed edit would leave the save button hidden and the navigate-away guard
			// silent, and the edit would be lost exactly on the devices #67 is about.
			if (chunked) {
				if (!editedReportedRef.current) {
					editedReportedRef.current = true

					post({
						type: "contentEdited"
					})
				}

				return
			}

			onValueChangeRef.current?.(doc)
		}, FLUSH_COMPOSITION_COMMIT_MS)
	}

	/**
	 * Streams the current document back to the host. The mirror of the load below, and bounded the
	 * same way: the bytes go through the write RPC rather than riding in a message payload.
	 *
	 * Blurs first so the keyboard commits an in-flight IME composition into the document before it is
	 * read — the hazard flushPendingContent exists for (#67), at the one moment it matters most.
	 */
	const writeDocument = async (requestId: string, post: (message: TextEditorEvents) => void) => {
		const write = writeChunkRef.current

		const fail = () => {
			post({
				type: "documentWriteFailed",
				data: {
					requestId
				}
			})
		}

		if (!write) {
			fail()

			return
		}

		codeMirrorRef.current?.view?.contentDOM.blur()

		await new Promise(resolve => setTimeout(resolve, FLUSH_COMPOSITION_COMMIT_MS))

		try {
			const doc = codeMirrorRef.current?.view?.state.doc.toString() ?? lastReportedValueRef.current

			if (!(await writeAllBytes(new TextEncoder().encode(doc), write))) {
				fail()

				return
			}

			lastReportedValueRef.current = doc

			// What was on screen is now on disk, so anything after this is a fresh change. Without the
			// reset the latch stays set, no later edit reports itself, and the save button never comes
			// back for the second edit of a session.
			editedReportedRef.current = false

			post({
				type: "documentWritten",
				data: {
					requestId
				}
			})
		} catch (e) {
			console.warn(`[textEditor] failed to serialise the document: ${e instanceof Error ? e.name : "unknown"}`)

			fail()
		}
	}

	const isTextFile = type === "text" || parseExtension(fileName ?? "file.tsx") === ".txt"

	const theme = (() => {
		if (isTextFile) {
			const textThemes = createTextThemes({
				backgroundColor: colors?.background?.primary ?? (darkMode ? "#0d1118" : "#ffffff"),
				textForegroundColor: colors?.text?.foreground ?? (darkMode ? "#c9d1d9" : "#24292e")
			})

			return textThemes[platform === "ios" ? "macOS" : "linux"][darkMode ? "dark" : "light"]
		}

		return platform === "android" ? (darkMode ? materialDark : materialLight) : darkMode ? xcodeDark : xcodeLight
	})()

	const extensions = (() => {
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
								fontSize: `${font?.size ?? 16}px !important`,
								fontFamily: `${font?.family ?? "inherit"} !important`
							}
						}
					: {
							".cm-gutters": {
								fontSize: `${font?.size ?? 14}px !important`,
								fontFamily: `${font?.family ?? "inherit"} !important`
							},
							".cm-line": {
								fontSize: `${font?.size ?? 14}px !important`,
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
	})()

	const { onNativeMessage, postMessage } = useDomDomEvents<TextEditorEvents>((message, post) => {
		if (message.type === "flushContent") {
			flushPendingContent(message.data.commitComposition, post)
		}

		if (message.type === "writeDocument") {
			writeDocument(message.data.requestId, post)
		}
	})
	const postMessageRef = useRef(postMessage)
	const readyEmittedRef = useRef(false)

	useEffect(() => {
		postMessageRef.current = postMessage
	})

	useDOMImperativeHandle(
		ref,
		() => ({
			postMessage: onNativeMessage
		}),
		[]
	)

	// Chunked mode: pull the document across the bridge rather than receive it as a prop. Mount-only
	// is safe here because the host renders this component only once its range source is open, and
	// keys it per document — so readRange/fileSize are present at mount and never change afterwards.
	useEffectOnce(() => {
		if (readRange === undefined || fileSize === undefined) {
			return
		}

		let cancelled = false

		const load = async () => {
			try {
				const text = await readAllText(readRange, fileSize, {
					isCancelled: () => cancelled
				})

				if (text === null || cancelled) {
					return
				}

				// Binary bytes behind a text extension (e.g. macOS "._*" AppleDouble sidecars) decode to
				// NUL/replacement-character soup. Refused rather than shown: it renders as deceptively
				// empty, and saving it would corrupt the file. Checked here rather than on the host
				// because the text deliberately no longer crosses the bridge for the host to inspect.
				if (isProbablyBinaryText(text)) {
					postMessageRef.current({
						type: "documentUnavailable",
						data: {
							reason: "notText"
						}
					})

					return
				}

				lastReportedValueRef.current = text

				setValue(text)

				postMessageRef.current({
					type: "documentLoaded"
				})
			} catch (e) {
				console.warn(`[textEditor] failed to load the document: ${e instanceof Error ? e.name : "unknown"}`)

				postMessageRef.current({
					type: "documentUnavailable",
					data: {
						reason: "loadFailed"
					}
				})
			}
		}

		load()

		return () => {
			cancelled = true
		}
	})

	useEffect(() => {
		// Emit "ready" exactly once per WebView mount, and register the window
		// listeners once. useDomDomEvents returns a new `postMessage` identity on
		// every render (no useCallback), so a naive [postMessage] dep would re-fire
		// "ready" and re-register the listeners on every parent re-render. The click
		// listener reads the latest `postMessage` through postMessageRef instead.
		if (!readyEmittedRef.current) {
			readyEmittedRef.current = true

			postMessageRef.current({
				type: "ready"
			})
		}

		const onClickListener = (e: PointerEvent) => {
			if (!(e.target instanceof HTMLElement)) {
				return
			}

			const link = e.target.closest("a[data-external-url]")

			if (!link) {
				return
			}

			const url = link.getAttribute("data-external-url")?.trim()

			if (!url) {
				return
			}

			postMessageRef.current({
				type: "externalLinkClicked",
				data: url
			})
		}

		window.addEventListener("click", onClickListener)

		return () => {
			window.removeEventListener("click", onClickListener)
		}
	}, [])

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
			value={value}
			width="100dvw"
			// Fill the page: an empty/short document otherwise leaves the editable surface only
			// as tall as its content, and tapping the (dead) area below it neither focuses nor
			// shows a cursor — an empty new note looked read-only (#67). With the editor at full
			// height, a tap anywhere focuses and places the cursor at the nearest position.
			minHeight="100dvh"
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

export default TextEditorDOM
