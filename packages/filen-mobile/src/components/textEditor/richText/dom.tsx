"use dom"

import "quill/dist/quill.snow.css"

import { type DOMProps, useDOMImperativeHandle } from "expo/dom"
import { useEffect, useRef, useCallback } from "react"
import type { DOMRef } from "@/hooks/useDomEvents/useNativeDomEvents"
import useDomDomEvents from "@/hooks/useDomEvents/useDomDomEvents"
import { installDomConsoleProxy } from "@/hooks/useDomEvents/domConsoleProxy"
import { decodeEditorInitialValue } from "@/components/textEditor/initialValueCodec"
import { quillV2ToLegacyV1 } from "@/components/textEditor/richText/quillCompat"
import Quill from "quill"
import DOMPurify from "dompurify"
import QuillThemeCustomizer, { getThemeOptions } from "@/components/textEditor/richText/quillTheme"
import type { Platform } from "react-native"
import type { TextEditorEvents, Colors, Font } from "@/components/textEditor"

// How long after a flush request (and its optional composition-committing blur) the document
// is re-read for the divergence check — long enough for the keyboard's finalized text to land
// through the normal event path, short enough to fit inside a screen-pop animation.
const FLUSH_COMPOSITION_COMMIT_MS = 80

// How long after the last DOM `input` event the live document is mirrored to native (#67).
// LatinIME-family keyboards (Heliboard, GrapheneOS/AOSP; iOS CJK keyboards behave alike) hold
// an IME composition open across the whole word or editing session, and Quill 2 suspends ALL
// text-change events while composing (Composition module batchStart/batchEnd) — so nothing
// incremental reaches native until the IME commits, and a leave-screen flush round trip cannot
// complete (React unmounts the screen at pop dispatch; only the native view survives the exit
// animation, so the WebView's reply is dropped). The `input` event still fires for every
// composing keystroke and the composed text is ordinary text nodes in the DOM, so this
// debounce-reads the document and reports through the same divergence gate the flush uses.
// On committing keyboards text-change reports first, the read compares equal, and this is a
// pure no-op — the healthy path stays single-reported.
//
// The value defines the leave-screen loss window: trailing debounce, so it fires this long
// after the LAST keystroke — leaving faster than this loses the final composing burst. It
// only needs to exceed Quill's mutation→text-change latency (microtasks, ~ms) so text-change
// wins the race on healthy keyboards; per-report cost is no more than what text-change
// already does per keystroke, so eager is cheap. 150ms is comfortably under the finger
// travel time to the back button.
const INPUT_MIRROR_DEBOUNCE_MS = 150

// Forward this WebView's console.* to the RN diagnostic logger (see domConsoleProxy).
installDomConsoleProxy()

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

const RichTextEditorDom = ({
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
	const quillThemeRef = useRef<QuillThemeCustomizer | null>(null)
	const quillFormatsRef = useRef<QuillFormats>({})
	// Mirrors the readOnly prop for the initial-seed effect, which must NOT depend on
	// readOnly (re-running it re-pastes the mount-frozen seed over typed content).
	const readOnlyRef = useRef(readOnly)
	const onValueChangeRef = useRef(onValueChange)

	// The last html value delivered to native — by a text-change event, a flush, or the
	// initial seed. The flush path only emits when the live document DIFFERS from this, so
	// on devices where change events work flushes are pure no-ops.
	const lastReportedHtmlRef = useRef<string | null>(null)

	useEffect(() => {
		readOnlyRef.current = readOnly
		onValueChangeRef.current = onValueChange
	}, [readOnly, onValueChange])

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

			// #67: report the final document iff it differs from the last value change events
			// delivered — some WebView/keyboard combos never fire change events for IME-composed
			// text. commitComposition blurs first so the keyboard finalizes the composing region
			// into the document through the normal event path.
			case "flushContent": {
				if (readOnlyRef.current) {
					break
				}

				if (message.data.commitComposition) {
					quillRef.current.blur()
				}

				setTimeout(() => {
					if (!quillRef.current) {
						return
					}

					const html = quillV2ToLegacyV1(quillRef.current.root.innerHTML)

					if (html === lastReportedHtmlRef.current) {
						return
					}

					lastReportedHtmlRef.current = html

					onValueChangeRef.current?.(html)
				}, FLUSH_COMPOSITION_COMMIT_MS)

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
		if (!editorRef.current || quillRef.current) {
			return
		}

		quillRef.current = new Quill(editorRef.current, {
			modules: {
				toolbar: false
			},
			placeholder,
			theme: "snow",
			readOnly: readOnly ?? false
		})

		// #39 fix: gate propagation on Quill's own user-vs-programmatic discriminator
		// (`source`), NOT a physical keydown. The old `didTypeRef` keydown gate dropped
		// paste / voice-dictation / autocomplete inserts (they emit no keydown). Quill
		// fires `source === "user"` for genuine user edits AND for toolbar formatting
		// (which already passes "user"), while the initial `dangerouslyPasteHTML(...,
		// "silent")` correctly does not propagate.
		quillRef.current.on("text-change", (_delta, _oldDelta, source) => {
			postFormatUpdates(postMessage)

			if (!quillRef.current || source !== "user") {
				return
			}

			// Persist lists and code blocks in Quill v1's on-disk form rather than
			// Quill v2's (<ol><li data-list>). v2 markup is read by web/desktop (Quill 1.3.7) as a plain
			// numbered list — checkboxes gone, bullets renumbered. See quillCompat for the mechanism.
			const html = quillV2ToLegacyV1(quillRef.current.root.innerHTML)

			// Divergence-gated like the mirror/flush paths: when a composition commit lands
			// content the input mirror already reported, skip the duplicate (#67). Only literal
			// duplicates of the last delivered value are skipped — any real change diverges.
			if (html === lastReportedHtmlRef.current) {
				return
			}

			lastReportedHtmlRef.current = html

			onValueChange?.(html)
		})

		quillRef.current.on("selection-change", () => {
			postFormatUpdates(postMessage)
		})

		// #67: mirror the live document to native while an IME composition suppresses Quill's
		// text-change events — see INPUT_MIRROR_DEBOUNCE_MS. `input` only fires for user edits
		// (programmatic seeding via dangerouslyPasteHTML does not dispatch it), and the
		// divergence gate keeps this silent whenever text-change already delivered the content.
		let inputMirrorTimer: ReturnType<typeof setTimeout> | null = null

		quillRef.current.root.addEventListener("input", () => {
			if (readOnlyRef.current) {
				return
			}

			if (inputMirrorTimer) {
				clearTimeout(inputMirrorTimer)
			}

			inputMirrorTimer = setTimeout(() => {
				if (!quillRef.current) {
					return
				}

				const html = quillV2ToLegacyV1(quillRef.current.root.innerHTML)

				if (html === lastReportedHtmlRef.current) {
					return
				}

				lastReportedHtmlRef.current = html

				onValueChangeRef.current?.(html)
			}, INPUT_MIRROR_DEBOUNCE_MS)
		})
	}, [placeholder, onValueChange, postFormatUpdates, postMessage, readOnly])

	// #40 fix: actually ENFORCE read-only. The Quill instance honours the construction
	// `readOnly` flag, and this effect re-applies it whenever the prop flips so a
	// read-only / shared / history note cannot be edited at all (CodeMirror already
	// honours `readOnly`; this was Quill-specific). Without it, a read-only edit wrote
	// to the inflight store and wedged note sync forever.
	useEffect(() => {
		quillRef.current?.enable(!readOnly)
	}, [readOnly])

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
			const sanitized = DOMPurify.sanitize(decodeEditorInitialValue(initialValue), {
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

			// #40 fix: never focus / place a caret in a read-only editor.
			if (autoFocus && !readOnlyRef.current) {
				quillRef.current.setSelection(sanitized.length, 0)
				quillRef.current.focus()
			}
		}

		// Baseline for the flush divergence check: the seeded (or empty) document as rendered.
		// Without it, the first flush of an untouched note would report the initial content as
		// an edit.
		lastReportedHtmlRef.current = quillV2ToLegacyV1(quillRef.current.root.innerHTML)
		// readOnly is read via a ref ON PURPOSE: re-running this effect re-pastes the
		// (mount-frozen) initialValue, so a mid-session readOnly flip (e.g. a permission
		// change arriving over the socket) would visually revert everything typed since
		// mount while the inflight store still holds the real text. Re-seeding is the
		// remount key's job; readOnly changes are applied by the theme effect above.
	}, [initialValue, autoFocus])

	const readyEmittedRef = useRef(false)

	useEffect(() => {
		// Emit "ready" exactly once per WebView mount. useDomDomEvents returns
		// a new `postMessage` identity on every render (no useCallback), so a
		// naive [postMessage] dep would re-fire on every parent re-render,
		// repeatedly invoking onReady and (previously) wiping the toolbar's
		// active format state.
		if (readyEmittedRef.current) {
			return
		}

		readyEmittedRef.current = true

		postMessage({
			type: "ready"
		})
	}, [postMessage])

	return (
		<div
			style={{
				backgroundColor: "transparent",
				display: "flex",
				// Real viewport sizing, not flex:1 — the WebView body is not a sized flex
				// parent, so flex:1 collapsed this chain to content height (#78).
				height: "100dvh",
				width: "100dvw",
				flexDirection: "column",
				touchAction: "pan-y"
			}}
		>
			<div
				ref={editorRef}
				style={{
					// Block, NOT display:flex: Quill's .ql-editor has no width rule, so as a
					// flex item it shrank to fit its content — an empty note's contenteditable
					// was a ~30px sliver at the top-left (only the placeholder's first word was
					// tappable; #78). As a block child it fills the container, and with the
					// sized ancestors above .ql-editor's height:100% fills the screen — a tap
					// anywhere focuses the editor.
					flex: 1,
					minHeight: 0,
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

export default RichTextEditorDom
