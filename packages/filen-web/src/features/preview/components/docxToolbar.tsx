import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react"
import { useTranslation } from "react-i18next"
import {
	BookOpenIcon,
	CaseSensitiveIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	EyeIcon,
	FileClockIcon,
	LockIcon,
	TriangleAlertIcon,
	MaximizeIcon,
	MessageSquareTextIcon,
	ReplaceAllIcon,
	ReplaceIcon,
	SearchIcon,
	WholeWordIcon,
	XIcon,
	ZoomInIcon
} from "lucide-react"
import {
	DOCX_MARKUP_MODES,
	isDocxCommandEnabled,
	type DocNotConverted,
	type DocxMarkupMode,
	type DocxViewerCommand,
	type DocxViewerState
} from "@filen/office/dom/docx"
import { cn } from "@filen/shared"
import {
	DOCX_ZOOM_FITS,
	DOCX_ZOOM_PRESETS,
	MARKUP_LABELS,
	notConvertedKey,
	viewOnlyReasonKey,
	viewerFindControls,
	type DocxFindControls,
	type DocxViewOnlyReason
} from "@/features/preview/components/docxViewer.logic"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { OfficeCommandBar, type RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { FullScreenButton, PageControls, ZoomControls } from "@/features/preview/components/commandBarControls"
import { BAR_BUTTON, pageControlsWidth, ZOOM_CONTROLS_WIDTH } from "@/features/preview/components/commandBar.logic"
import { useAction } from "@/lib/keymap/useAction"
import { isImeKeydown } from "@filen/shared/keymap"
import type { Options } from "react-hotkeys-hook"

// The DOCX viewer's command bar (OfficeCommandBar), as the PDF viewer's: File, then Pages (first, previous, the page
// number field, next, last), Zoom (out, the zoom menu with its steps and fit to width, in), the markup menu (a
// document with comments or tracked changes), Full screen and Find; the badges, the page and the zoom at the end. The
// find field takes the groups' place while finding. Everything it shows comes from the viewer's command state;
// everything it does is a viewer command.

// Typing waits this long before the document is searched (each search runs over every page).
const FIND_DEBOUNCE_MS = 150
// The find field's own keys answer in its inputs too.
const FIELD_KEYS: Options = { enableOnFormTags: ["input"] }
const FIELD_CLASS =
	"h-7 w-40 min-w-0 rounded-xl bg-muted/60 pr-2 pl-7 text-xs leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-50 max-sm:w-full [&::-webkit-search-cancel-button]:appearance-none"

export interface DocxToolbarProps {
	state: DocxViewerState
	dispatch: (command: DocxViewerCommand) => void
	// Null for a document without comments or tracked changes.
	markup: DocxMarkupMode | null
	onMarkupChange: (mode: DocxMarkupMode) => void
	viewOnly: readonly DocxViewOnlyReason[]
	// Opened with its password, and whether its integrity was verified.
	encrypted?: PasswordIntegrity | undefined
	// A Word 97–2003 document shown from its conversion: what did not convert as it was, and Save as .docx (when a
	// copy may be saved beside the file).
	legacy?: DocxLegacyInfo | undefined
	// Bumped to focus the find field (and select its text) again while it is open.
	findFocus: number
	// Where focus goes when the find field closes.
	onFindClosed: () => void
	// The File menu (Download as), first on the left; absent when it offers nothing.
	fileMenu?: ReactNode
	// The page number field, which Go To focuses.
	pageInputRef?: Ref<HTMLInputElement>
}

export function ViewOnlyBadge({ reasons }: { reasons: readonly DocxViewOnlyReason[] }) {
	const { t } = useTranslation("preview")

	return (
		<Popover>
			<Badge
				variant="outline"
				className="cursor-pointer text-muted-foreground hover:bg-muted"
				render={<PopoverTrigger aria-label={t("previewDocxViewOnly")} />}
			>
				<EyeIcon data-icon="inline-start" />
				<span className="max-sm:hidden">{t("previewDocxViewOnly")}</span>
			</Badge>
			<PopoverContent
				align="start"
				className="gap-2"
			>
				<p className="font-medium">{t("previewDocxViewOnlyTitle")}</p>
				<ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
					{reasons.map(reason => (
						<li key={reason}>{t(viewOnlyReasonKey(reason))}</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	)
}

export interface DocxLegacyInfo {
	readonly notConverted: readonly DocNotConverted[]
	readonly onSaveAs: (() => void) | undefined
}

// A Word 97–2003 document: read-only, converted to be shown; the popover lists what is shown differently, and offers
// Save as .docx, also where the toolbar has no room for its button.
export function LegacyBadge({ notConverted, onSaveAs }: DocxLegacyInfo) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const titleId = useId()

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<Badge
				variant="outline"
				className="cursor-pointer text-muted-foreground hover:bg-muted"
				render={<PopoverTrigger aria-label={t("previewDocxLegacyTitle")} />}
			>
				<FileClockIcon data-icon="inline-start" />
				<span className="max-sm:hidden">{t("previewDocxLegacyBadge")}</span>
			</Badge>
			<PopoverContent
				align="start"
				className="gap-2"
				aria-labelledby={titleId}
			>
				<p
					id={titleId}
					className="font-medium"
				>
					{t("previewDocxLegacyTitle")}
				</p>
				<p className="text-muted-foreground">
					{t(onSaveAs === undefined ? "previewDocxLegacyBodyReadOnly" : "previewDocxLegacyBody")}
				</p>
				{notConverted.length === 0 ? null : (
					<>
						<p className="text-muted-foreground">{t("previewDocxLegacyNotConverted")}</p>
						<ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
							{notConverted.map(item => (
								<li key={item.kind}>{t(notConvertedKey(item.kind), { count: item.count })}</li>
							))}
						</ul>
					</>
				)}
				{onSaveAs === undefined ? null : (
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						onClick={() => {
							setOpen(false)
							onSaveAs()
						}}
					>
						{t("previewDocxSaveAsDocx")}
					</Button>
				)}
			</PopoverContent>
		</Popover>
	)
}

// Whether an encrypted package's integrity was verified ([MS-OFFCRYPTO] §2.3.4.14 dataIntegrity HMAC), or could
// not be: Standard encryption has none, and an Agile file may leave it out, so its content may have been changed.
export type PasswordIntegrity = "verified" | "unchecked"

// A document opened with its password: `saving` while its saves keep the password (an editor that can save),
// else it was decrypted here only. An unchecked one says so, in the popover and as the badge's description.
export function PasswordBadge({ integrity, saving }: { integrity: PasswordIntegrity; saving: boolean }) {
	const { t } = useTranslation("preview")
	const noteId = useId()
	const unchecked = integrity === "unchecked"

	return (
		<Popover>
			<Badge
				variant="outline"
				className={cn("cursor-pointer hover:bg-muted", unchecked ? "text-warning-foreground" : "text-muted-foreground")}
				render={
					<PopoverTrigger
						aria-label={t("previewDocxPasswordProtected")}
						aria-describedby={unchecked ? noteId : undefined}
					/>
				}
			>
				{unchecked ? <TriangleAlertIcon data-icon="inline-start" /> : <LockIcon data-icon="inline-start" />}
				<span className="max-sm:hidden">{t("previewDocxPasswordProtected")}</span>
			</Badge>
			{unchecked ? (
				<span
					id={noteId}
					className="sr-only"
				>
					{t("previewDocxPasswordUnchecked")}
				</span>
			) : null}
			<PopoverContent
				align="start"
				className="gap-2"
			>
				<p className="font-medium">{t("previewDocxPasswordProtected")}</p>
				<p className="text-muted-foreground">{t(saving ? "previewDocxPasswordSaved" : "previewDocxPasswordOpened")}</p>
				{unchecked ? <p className="text-warning-foreground">{t("previewDocxPasswordUnchecked")}</p> : null}
			</PopoverContent>
		</Popover>
	)
}

export function MarkupMenu({
	mode,
	onChange,
	disabled
}: {
	mode: DocxMarkupMode
	onChange: (mode: DocxMarkupMode) => void
	// Modes that cannot be switched to now (another layout while edits are unsaved).
	disabled?: (mode: DocxMarkupMode) => boolean
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="sm"
									aria-label={`${t("previewDocxMarkup")}: ${t(MARKUP_LABELS[mode])}`}
									className="px-2"
								>
									<MessageSquareTextIcon />
									<span className="text-xs max-md:hidden">{t(MARKUP_LABELS[mode])}</span>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("previewDocxMarkup")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent
				align="end"
				finalFocus={focus.finalFocus}
				className="w-auto min-w-40"
			>
				<DropdownMenuRadioGroup
					value={mode}
					onValueChange={(next: DocxMarkupMode) => {
						onChange(next)
						focus.ran()
					}}
				>
					<DropdownMenuLabel>{t("previewDocxMarkup")}</DropdownMenuLabel>
					{DOCX_MARKUP_MODES.map(info => (
						<DropdownMenuRadioItem
							key={info.mode}
							value={info.mode}
							disabled={disabled?.(info.mode) === true}
							closeOnClick
						>
							{t(MARKUP_LABELS[info.mode])}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function DocxFindField({
	find,
	focus,
	onClosed,
	replaceOpen: replaceOpenProp,
	replaceAction
}: {
	find: DocxFindControls
	// Bumped to focus the find field (and select its text) again while it is open.
	focus: number
	onClosed: () => void
	// Opened as "Find and replace": the replace field shows from the start.
	replaceOpen?: boolean
	// The action whose key moves to the replace field: editor.replace, or the Word editor's own (docx.replace).
	replaceAction?: string
}) {
	const { t } = useTranslation("preview")
	const [text, setText] = useState(find.query)
	// A query set from outside the field (Find seeded from the selection while open) replaces what it holds.
	const [givenQuery, setGivenQuery] = useState(find.query)

	if (givenQuery !== find.query) {
		setGivenQuery(find.query)
		setText(find.query)
	}

	const [replacement, setReplacement] = useState("")
	const [replaceOpen, setReplaceOpen] = useState(replaceOpenProp === true)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const inputRef = useRef<HTMLInputElement | null>(null)
	const replaceRef = useRef<HTMLInputElement | null>(null)
	const focusReplace = useRef(false)
	const searched = text === find.query
	const current = find.count === 0 ? 0 : find.active + 1
	const counts = { current, total: find.count }
	const replace = find.replace

	// Mod+F again in the field selects what it holds, as in a browser's find bar.
	const findAgain = useAction(
		"editor.find",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			inputRef.current?.select()
		},
		{ enableOnFormTags: ["input"] }
	)
	// The replace key in the field shows the replace field and moves there, where the document can be changed.
	const replaceFromFind = useAction(
		replaceAction ?? "editor.replace",
		keyboardEvent => {
			if (replace === undefined) {
				return
			}

			keyboardEvent.preventDefault()

			if (replaceRef.current === null) {
				focusReplace.current = true
				setReplaceOpen(true)
			} else {
				replaceRef.current.focus()
			}
		},
		{ enableOnFormTags: ["input"] },
		[replace]
	)

	useEffect(() => {
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [focus])

	useEffect(() => {
		return () => {
			if (timer.current !== null) {
				clearTimeout(timer.current)
			}
		}
	}, [])

	const search = (query: string, caseSensitive: boolean, wholeWord: boolean | undefined): void => {
		if (timer.current !== null) {
			clearTimeout(timer.current)
			timer.current = null
		}

		find.search(query, caseSensitive, wholeWord)
	}

	const close = (): void => {
		find.close()
		onClosed()
	}

	// The next or previous match; what is typed is searched first when it has not been yet.
	const step = (direction: 1 | -1): void => {
		if (!searched) {
			search(text, find.caseSensitive, find.wholeWord)
		} else {
			find.step(direction)
		}
	}

	const replaceAll = (): void => {
		if (replace === undefined || !replaceOpen || replace.disabled || find.count === 0 || !searched) {
			return
		}

		// No match is left, and Replace all disables itself: focus goes to the find field.
		inputRef.current?.focus()
		replace.all(replacement)
	}

	// The field's own keys, anywhere in it (the find and replace inputs, its buttons): the next and previous match, the
	// match toggles and Replace all. Ahead of the inputs' own Enter (onFieldKeyDown leaves a key taken here alone).
	const findNextKey = useAction(
		"editor.findNext",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			step(1)
		},
		FIELD_KEYS,
		[searched, text, find]
	)
	const findPreviousKey = useAction(
		"editor.findPrevious",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			step(-1)
		},
		FIELD_KEYS,
		[searched, text, find]
	)
	const matchCaseKey = useAction(
		"editor.findMatchCase",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			search(text, !find.caseSensitive, find.wholeWord)
		},
		FIELD_KEYS,
		[text, find]
	)
	const wholeWordKey = useAction(
		"editor.findWholeWord",
		keyboardEvent => {
			if (find.wholeWord === undefined) {
				return
			}

			keyboardEvent.preventDefault()
			search(text, find.caseSensitive, !find.wholeWord)
		},
		FIELD_KEYS,
		[text, find]
	)
	const replaceAllKey = useAction(
		"editor.replaceAll",
		keyboardEvent => {
			if (replace === undefined || !replaceOpen) {
				return
			}

			keyboardEvent.preventDefault()
			replaceAll()
		},
		FIELD_KEYS,
		[replace, replaceOpen, replacement, find, searched]
	)

	// Keys an input method is composing with are its own (Enter confirms the composition); Escape is taken
	// here, as the preview overlay closes on an Escape nothing inside took. Enter with Shift steps back; with any other
	// modifier it is some shortcut's.
	const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>, enter: (shift: boolean) => void): void => {
		if (event.defaultPrevented || isImeKeydown(event.nativeEvent)) {
			return
		}

		if (event.key === "Escape") {
			event.preventDefault()
			close()
		} else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault()
			enter(event.shiftKey)
		}
	}

	// One row, in reading order; on a phone the replace field and its buttons wrap onto a second row, with Close last
	// after them, so neither field is squeezed and the order seen is the order tabbed.
	return (
		<div
			ref={element => {
				findNextKey(element)
				findPreviousKey(element)
				matchCaseKey(element)
				wholeWordKey(element)
				replaceAllKey(element)
			}}
			className="flex min-w-0 flex-wrap items-center gap-1"
		>
			<div className="relative min-w-0 max-sm:flex-1">
				<SearchIcon
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					ref={element => {
						inputRef.current = element
						findAgain(element)
						replaceFromFind(element)
					}}
					type="search"
					aria-label={t("previewDocxFindPlaceholder")}
					placeholder={t("previewDocxFindPlaceholder")}
					value={text}
					className={FIELD_CLASS}
					onChange={event => {
						const query = event.target.value

						setText(query)

						if (timer.current !== null) {
							clearTimeout(timer.current)
						}

						timer.current = setTimeout(() => {
							timer.current = null
							find.search(query, find.caseSensitive, find.wholeWord)
						}, FIND_DEBOUNCE_MS)
					}}
					onKeyDown={event => {
						onFieldKeyDown(event, shift => {
							step(shift ? -1 : 1)
						})
					}}
				/>
			</div>
			<span
				aria-hidden="true"
				className="min-w-12 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
			>
				{text.length > 0 && searched ? t(find.capped ? "previewDocxFindCountCapped" : "previewDocxFindCount", counts) : null}
			</span>
			<span
				role="status"
				className="sr-only"
			>
				{text.length > 0 && searched
					? find.count === 0
						? t("previewDocxFindNoMatches")
						: t(find.capped ? "previewDocxFindStatusCapped" : "previewDocxFindStatus", counts)
					: null}
			</span>
			<TooltipIconButton
				label={t("previewDocxFindPrevious")}
				shortcut={<Kbd action="editor.findPrevious" />}
				disabled={find.count === 0}
				onClick={() => {
					find.step(-1)
				}}
			>
				<ChevronUpIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewDocxFindNext")}
				shortcut={<Kbd action="editor.findNext" />}
				disabled={find.count === 0}
				onClick={() => {
					find.step(1)
				}}
			>
				<ChevronDownIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewDocxFindMatchCase")}
				shortcut={<Kbd action="editor.findMatchCase" />}
				pressed={find.caseSensitive}
				className={find.caseSensitive ? "bg-accent text-foreground" : undefined}
				onClick={() => {
					search(text, !find.caseSensitive, find.wholeWord)
				}}
			>
				<CaseSensitiveIcon />
			</TooltipIconButton>
			{find.wholeWord === undefined ? null : (
				<TooltipIconButton
					label={t("previewDocxFindWholeWords")}
					shortcut={<Kbd action="editor.findWholeWord" />}
					pressed={find.wholeWord}
					className={find.wholeWord ? "bg-accent text-foreground" : undefined}
					onClick={() => {
						search(text, find.caseSensitive, find.wholeWord !== true)
					}}
				>
					<WholeWordIcon />
				</TooltipIconButton>
			)}
			{replace === undefined ? null : (
				<TooltipIconButton
					label={t("previewDocxShowReplace")}
					pressed={replaceOpen}
					className={replaceOpen ? "bg-accent text-foreground" : undefined}
					onClick={() => {
						setReplaceOpen(open => !open)
					}}
				>
					<ReplaceIcon />
				</TooltipIconButton>
			)}
			{replace === undefined || !replaceOpen ? null : (
				<div className="flex min-w-0 items-center gap-1 max-sm:flex-1 max-sm:basis-[calc(100%-2rem)]">
					<input
						ref={element => {
							replaceRef.current = element

							// Shown by the replace key: focus follows it there.
							if (element !== null && focusReplace.current) {
								focusReplace.current = false
								element.focus()
							}
						}}
						type="text"
						aria-label={t("previewDocxReplacePlaceholder")}
						placeholder={t("previewDocxReplacePlaceholder")}
						value={replacement}
						disabled={replace.disabled}
						className={cn(FIELD_CLASS, "pl-2 max-sm:flex-1")}
						onChange={event => {
							setReplacement(event.target.value)
						}}
						onKeyDown={event => {
							onFieldKeyDown(event, () => {
								if (find.count > 0 && searched) {
									replace.one(replacement)
								}
							})
						}}
					/>
					<TooltipIconButton
						label={t("previewDocxReplace")}
						disabled={replace.disabled || find.count === 0 || !searched}
						onClick={() => {
							// The last match replaced disables this button: focus goes to the find field, not the overlay.
							if (find.count === 1) inputRef.current?.focus()

							replace.one(replacement)
						}}
					>
						<ReplaceIcon />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewDocxReplaceAll")}
						shortcut={<Kbd action="editor.replaceAll" />}
						disabled={replace.disabled || find.count === 0 || !searched}
						onClick={replaceAll}
					>
						<ReplaceAllIcon />
					</TooltipIconButton>
				</div>
			)}
			<TooltipIconButton
				label={t("previewDocxFindClose")}
				onClick={close}
			>
				<XIcon />
			</TooltipIconButton>
		</div>
	)
}

// The markup menu's button with its mode's name.
const MARKUP_WIDTH = 120

export function DocxToolbar({
	state,
	dispatch,
	markup,
	onMarkupChange,
	viewOnly,
	encrypted,
	legacy,
	findFocus,
	onFindClosed,
	fileMenu,
	pageInputRef
}: DocxToolbarProps) {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const percent = Math.round(state.zoom * 100)
	const page = Math.min(state.page + 1, state.pageCount)
	const groups: RibbonGroup[] = [
		{
			id: "pages",
			label: t("previewCommandBarPages"),
			icon: BookOpenIcon,
			width: pageControlsWidth(!phone),
			priority: Infinity,
			content: (
				<PageControls
					page={page}
					total={state.pageCount}
					ends={!phone}
					canPrevious={isDocxCommandEnabled(state, "page.previous")}
					canNext={isDocxCommandEnabled(state, "page.next")}
					onGo={target => {
						dispatch({ type: "page.goto", page: target - 1 })
					}}
					onPrevious={() => {
						dispatch({ type: "page.previous" })
					}}
					onNext={() => {
						dispatch({ type: "page.next" })
					}}
					onFirst={() => {
						dispatch({ type: "page.goto", page: 0 })
					}}
					onLast={() => {
						dispatch({ type: "page.goto", page: Math.max(0, state.pageCount - 1) })
					}}
					inputRef={pageInputRef}
				/>
			)
		},
		{
			id: "zoom",
			label: t("previewOfficeRibbonZoom"),
			icon: ZoomInIcon,
			width: ZOOM_CONTROLS_WIDTH,
			priority: 5,
			content: (
				<ZoomControls
					percent={percent}
					presets={DOCX_ZOOM_PRESETS}
					fits={DOCX_ZOOM_FITS}
					mode={state.zoomMode === "fitWidth" ? "fitWidth" : "custom"}
					canIn={isDocxCommandEnabled(state, "zoom.in")}
					canOut={isDocxCommandEnabled(state, "zoom.out")}
					onIn={() => {
						dispatch({ type: "zoom.in" })
					}}
					onOut={() => {
						dispatch({ type: "zoom.out" })
					}}
					onPercent={next => {
						dispatch({ type: "zoom.set", zoom: next / 100 })
					}}
					onFit={() => {
						dispatch({ type: "zoom.fitWidth" })
					}}
				/>
			)
		}
	]

	if (markup !== null) {
		groups.push({
			id: "markup",
			label: t("previewDocxMarkup"),
			icon: MessageSquareTextIcon,
			width: MARKUP_WIDTH,
			priority: 4,
			single: true,
			content: (
				<MarkupMenu
					mode={markup}
					onChange={onMarkupChange}
				/>
			)
		})
	}

	if (fullscreenSupported()) {
		groups.push({
			id: "view",
			label: t("previewOfficeRibbonTabView"),
			icon: MaximizeIcon,
			width: BAR_BUTTON,
			priority: 1,
			single: true,
			content: <FullScreenButton />
		})
	}

	groups.push({
		id: "find",
		label: t("previewEditorFind"),
		icon: SearchIcon,
		width: BAR_BUTTON,
		priority: Infinity,
		single: true,
		content: (
			<RibbonButton
				label={t("previewDocxFindAction")}
				icon={<SearchIcon />}
				disabled={!isDocxCommandEnabled(state, "find.open")}
				shortcut={<Kbd action="editor.find" />}
				onClick={() => {
					dispatch({ type: "find.open" })
				}}
			/>
		)
	})

	return (
		<OfficeCommandBar
			label={t("previewOfficeRibbonCommands")}
			file={fileMenu}
			groups={groups}
			replacement={
				state.find.open ? (
					<DocxFindField
						find={viewerFindControls(state, dispatch)}
						focus={findFocus}
						onClosed={onFindClosed}
					/>
				) : undefined
			}
			status={
				<>
					{viewOnly.length > 0 ? <ViewOnlyBadge reasons={viewOnly} /> : null}
					{encrypted === undefined ? null : (
						<PasswordBadge
							integrity={encrypted}
							saving={false}
						/>
					)}
					{legacy === undefined ? null : (
						<LegacyBadge
							notConverted={legacy.notConverted}
							onSaveAs={legacy.onSaveAs}
						/>
					)}
					{/* A Word 97–2003 document is only ever edited as its .docx: the way there is in plain sight (on a phone
					    the badge's popover offers it). */}
					{legacy?.onSaveAs === undefined ? null : (
						<Button
							variant="outline"
							size="xs"
							className="shrink-0 max-sm:hidden"
							onClick={legacy.onSaveAs}
						>
							{t("previewDocxSaveAsDocx")}
						</Button>
					)}
					<span className="ml-2 flex items-center gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
						<span>{t("previewDocxPageIndicator", { current: page, total: state.pageCount })}</span>
						<span>{t("previewDocxZoomIndicator", { percent })}</span>
					</span>
				</>
			}
		/>
	)
}
