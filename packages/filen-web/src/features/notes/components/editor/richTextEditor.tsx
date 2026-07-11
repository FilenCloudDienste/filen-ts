import "quill/dist/quill.snow.css"

import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import Quill, { Range } from "quill"
import {
	BoldIcon,
	ItalicIcon,
	UnderlineIcon,
	HeadingIcon,
	CodeIcon,
	QuoteIcon,
	ListIcon,
	ListOrderedIcon,
	ListChecksIcon,
	LinkIcon,
	UnlinkIcon
} from "lucide-react"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
	EMPTY_RICH_FORMATS,
	reflectRichFormats,
	shouldPropagateRichChange,
	seedRichEditor,
	applyRichReadOnly,
	cycleHeaderValue,
	nextListValue,
	nextToggleValue,
	type RichActiveFormats
} from "@/features/notes/components/editor/richTextEditor.logic"

// Reflect the live selection's formats into React state (mobile's postFormatUpdates, sans the bridge).
// Keeps the last non-null range for toolbar actions that fire after the editor loses focus (the link
// popover), and — like mobile — does NOT clear the toolbar when there is no selection (returns early),
// so a blur does not flicker every active mark off.
function pullFormats(quill: Quill, lastRange: RefObject<Range | null>, setFormats: (formats: RichActiveFormats) => void): void {
	const range = quill.getSelection()

	if (!range) {
		return
	}

	lastRange.current = range

	setFormats(reflectRichFormats(quill.getFormat(range)))
}

// A single toolbar control: an icon button reflecting active state, with a tooltip carrying its label.
// onMouseDown is prevented so clicking it never blurs the editor and drops the selection the format
// applies to (the standard custom-toolbar technique).
function ToolbarButton({
	label,
	active = false,
	disabled = false,
	onPress,
	children
}: {
	label: string
	active?: boolean
	disabled?: boolean
	onPress: () => void
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant={active ? "secondary" : "ghost"}
						size="icon-sm"
						disabled={disabled}
						aria-label={label}
						aria-pressed={active}
						onMouseDown={event => {
							event.preventDefault()
						}}
						onClick={onPress}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

// Quill rich-text editor (01-DECISIONS D1: mobile parity — sanitized, XSS-safe), driving the Quill
// instance directly (no WebView bridge). A custom React toolbar calls quill.format(...) and reflects
// active formats from the selection. The CALLER keys this on controller.remountKey so the seed freezes
// at mount and only a real reseed remounts it (the EDITOR INVARIANT).
export function RichTextEditor({ controller }: { controller: NoteEditorController }) {
	const { t } = useTranslation("notes")
	const editorRef = useRef<HTMLDivElement | null>(null)
	const quillRef = useRef<Quill | null>(null)
	// The mount-frozen seed + placeholder + initial read-only, read once in the mount effect so it never
	// depends on a re-rendered prop (re-pasting the seed would revert typed text — richText/dom.tsx:333).
	const seedRef = useRef(controller.seed)
	const readOnlyRef = useRef(controller.readOnly)
	// The outbox enqueue callback, held in a ref so the text-change listener always calls the freshest
	// identity without re-subscribing (mount-once listener).
	const onChangeRef = useRef(controller.onChange)
	// Last non-null selection, for toolbar actions that run after a focus shift (the link popover).
	const lastRangeRef = useRef<Range | null>(null)
	const [formats, setFormats] = useState<RichActiveFormats>(EMPTY_RICH_FORMATS)
	const [linkOpen, setLinkOpen] = useState(false)
	const [linkUrl, setLinkUrl] = useState("")

	useEffect(() => {
		onChangeRef.current = controller.onChange
	})

	// #40 enforcement: re-apply read-only when the prop flips (the editor only mounts writable today, but
	// this keeps a mid-session flip from ever accepting edits that would wedge sync).
	useEffect(() => {
		const quill = quillRef.current

		if (quill) {
			applyRichReadOnly(quill, controller.readOnly)
		}
	}, [controller.readOnly])

	// Mount-once construction + seed. Guarded so React's dev double-invoke never builds a second Quill
	// into the same node. All references are module imports, refs or the stable state setter, so the
	// empty dep array is intentional and lint-clean — reseeding is the remount key's job.
	useEffect(() => {
		const el = editorRef.current

		if (!el || quillRef.current) {
			return
		}

		const quill = new Quill(el, {
			modules: {
				toolbar: false
			},
			placeholder: t("noteRichPlaceholder"),
			theme: "snow",
			readOnly: readOnlyRef.current
		})

		quillRef.current = quill

		// #39 gate: propagate only Quill-source "user" edits (typing/paste/dictation/autocomplete). The
		// silent seed paste below never reaches onChange.
		quill.on("text-change", (_delta, _oldContent, source) => {
			pullFormats(quill, lastRangeRef, setFormats)

			if (shouldPropagateRichChange(source)) {
				onChangeRef.current(quill.root.innerHTML)
			}
		})

		quill.on("selection-change", () => {
			pullFormats(quill, lastRangeRef, setFormats)
		})

		// Sanitize-before-seed, pasted "silent" so it never propagates (richText/dom.tsx). Never focus a
		// read-only editor (#40) — web does not autofocus at all, so there is no caret placement to guard.
		seedRichEditor(quill, seedRef.current)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Restore the editor selection (lost to a focus shift for the popover), run the format, reflect it.
	function runFormat(action: (quill: Quill) => void): void {
		const quill = quillRef.current

		if (!quill) {
			return
		}

		const range = quill.getSelection() ?? lastRangeRef.current

		if (range) {
			quill.setSelection(range, "silent")
		}

		action(quill)
		pullFormats(quill, lastRangeRef, setFormats)
	}

	function submitLink(): void {
		const url = linkUrl.trim()

		setLinkOpen(false)
		setLinkUrl("")

		if (url.length === 0) {
			return
		}

		runFormat(quill => quill.format("link", url, "user"))
	}

	return (
		<div className="notes-rich-editor flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border/50 px-3 py-1.5">
				<ToolbarButton
					label={t("noteRichBold")}
					active={formats.bold}
					onPress={() => {
						runFormat(quill => quill.format("bold", nextToggleValue(formats.bold), "user"))
					}}
				>
					<BoldIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichItalic")}
					active={formats.italic}
					onPress={() => {
						runFormat(quill => quill.format("italic", nextToggleValue(formats.italic), "user"))
					}}
				>
					<ItalicIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichUnderline")}
					active={formats.underline}
					onPress={() => {
						runFormat(quill => quill.format("underline", nextToggleValue(formats.underline), "user"))
					}}
				>
					<UnderlineIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichHeading")}
					active={formats.header !== null}
					onPress={() => {
						runFormat(quill => quill.format("header", cycleHeaderValue(formats.header), "user"))
					}}
				>
					<HeadingIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichCode")}
					active={formats.codeBlock}
					onPress={() => {
						runFormat(quill => quill.format("code-block", nextToggleValue(formats.codeBlock), "user"))
					}}
				>
					<CodeIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichQuote")}
					active={formats.blockquote}
					onPress={() => {
						runFormat(quill => quill.format("blockquote", nextToggleValue(formats.blockquote), "user"))
					}}
				>
					<QuoteIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichOrderedList")}
					active={formats.list === "ordered"}
					onPress={() => {
						runFormat(quill => quill.format("list", nextListValue(formats.list, "ordered"), "user"))
					}}
				>
					<ListOrderedIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichBulletList")}
					active={formats.list === "bullet"}
					onPress={() => {
						runFormat(quill => quill.format("list", nextListValue(formats.list, "bullet"), "user"))
					}}
				>
					<ListIcon />
				</ToolbarButton>
				<ToolbarButton
					label={t("noteRichCheckList")}
					active={formats.list === "checked" || formats.list === "unchecked"}
					onPress={() => {
						runFormat(quill => quill.format("list", nextListValue(formats.list, "checklist"), "user"))
					}}
				>
					<ListChecksIcon />
				</ToolbarButton>
				<Popover
					open={linkOpen}
					onOpenChange={setLinkOpen}
				>
					<Tooltip>
						<TooltipTrigger
							render={
								<PopoverTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("noteRichLink")}
											onMouseDown={() => {
												// Keep the selection the link will apply to; the popover input is about to take focus.
												const quill = quillRef.current
												const range = quill?.getSelection()

												if (range) {
													lastRangeRef.current = range
												}
											}}
										>
											<LinkIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("noteRichLink")}</TooltipContent>
					</Tooltip>
					<PopoverContent className="w-72 p-2">
						<form
							className="flex items-center gap-2"
							onSubmit={event => {
								event.preventDefault()
								submitLink()
							}}
						>
							<Input
								type="url"
								value={linkUrl}
								autoFocus
								aria-label={t("noteRichLinkUrl")}
								placeholder={t("noteRichLinkUrl")}
								onChange={event => {
									setLinkUrl(event.target.value)
								}}
							/>
							<Button
								type="submit"
								size="sm"
							>
								{t("noteRichLinkAdd")}
							</Button>
						</form>
					</PopoverContent>
				</Popover>
				<ToolbarButton
					label={t("noteRichUnlink")}
					disabled={formats.link === null}
					onPress={() => {
						runFormat(quill => quill.format("link", false, "user"))
					}}
				>
					<UnlinkIcon />
				</ToolbarButton>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<div ref={editorRef} />
			</div>
		</div>
	)
}
