import { useId, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import {
	DOCX_NOTE_NUMBER_FORMATS,
	FIELD_CATALOGUE,
	datePictures,
	linkTargetRefusal,
	parseDocxEditorCommand,
	sessionBookmarks,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxEditorSnapshot,
	type DocxNoteKind,
	type DocxNoteNumberFormat,
	type DocxNotePosition,
	type DocxNoteRestart
} from "@filen/office/core/docx/edit"
import { currentNoteOptions, docxBookmarks, docxOutline, formatDatePicture, type PagedEditor } from "@filen/office/core/docx/paged"
import { cn } from "@filen/shared"
import type { DocxInputRequest } from "@/features/preview/components/docxEditor.logic"
import {
	caretLanguage,
	NAMED_SYMBOLS,
	SYMBOLS,
	fieldExample,
	fieldNameKey,
	linkTarget
} from "@/features/preview/components/docxInsert.logic"
import { DocxChoiceField, DocxRowsColumnsDialog } from "@/features/preview/components/docxFields"
import { FormDialog } from "@/components/dialogs/formDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { PreviewKey } from "@/lib/i18n"

// The dialogs the Insert menu, the Picture group and the context menu ask for (through the input channel):
// a link, a symbol, a date, a table of contents, a field, bookmarks, note options, a table's size, a picture's
// alt text. Each runs its command through the host (`execute`) and is done when it closes.

export interface DocxInsertDialogsProps {
	request: DocxInputRequest
	editor: PagedEditor
	snapshot: DocxEditorSnapshot | undefined
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	onDone: (nonce: number) => void
}

interface DialogProps {
	editor: PagedEditor
	snapshot: DocxEditorSnapshot | undefined
	// The command may run now.
	enabled: (type: DocxEditorCommandType) => boolean
	// Runs a command from untrusted values (parsed first; nothing runs when they do not hold).
	run: (value: object) => boolean
	close: () => void
}

export function DocxInsertDialogs({ request, editor, snapshot, readOnly, execute, onDone }: DocxInsertDialogsProps) {
	const props: DialogProps = {
		editor,
		snapshot,
		enabled: type => !readOnly && snapshot !== undefined && !snapshot.readOnly && snapshot.enabled[type],
		run: value => {
			const command = parseDocxEditorCommand(value)

			if (command === undefined) {
				return false
			}

			execute(command)

			return true
		},
		close: () => {
			onDone(request.nonce)
		}
	}

	switch (request.type) {
		case "link.set":
			return <LinkDialog {...props} />
		case "insert.symbol":
			return <SymbolDialog {...props} />
		case "insert.date":
			return <DateDialog {...props} />
		case "toc.insert":
			return <TocDialog {...props} />
		case "insert.field":
			return <FieldDialog {...props} />
		case "bookmark.add":
		case "bookmark.rename":
		case "bookmark.delete":
			return <BookmarkDialog {...props} />
		case "note.options":
			return <NoteOptionsDialog {...props} />
		case "table.insert":
			return <TableSizeDialog {...props} />
		case "drawing.altText":
			return <AltTextDialog {...props} />
		default:
			return null
	}
}

function submitted(event: SubmitEvent, submit: () => void): void {
	event.preventDefault()
	submit()
}

interface ChoiceOption {
	value: string
	label: string
}

function NumberField({
	label,
	value,
	min,
	max,
	onChange
}: {
	label: string
	value: string
	min: number
	max: number
	onChange: (value: string) => void
}) {
	const id = useId()

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={min}
				max={max}
				value={value}
				onChange={event => {
					onChange(event.target.value)
				}}
			/>
		</Field>
	)
}

function whole(value: string): number {
	return /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
}

// ---- table size ------------------------------------------------------------------------------------------

// The size of a new table (Word's Insert Table: five columns, two rows).
function TableSizeDialog({ enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")

	return (
		<DocxRowsColumnsDialog
			title={t("previewDocxTableSizeTitle")}
			description={t("previewDocxTableSizeDescription")}
			submitLabel={t("previewDocxInsertAction")}
			initial={{ rows: 2, cols: 5 }}
			accepts={() => enabled("table.insert")}
			onSubmit={size => run({ type: "table.insert", rows: size.rows, cols: size.cols })}
			onClose={close}
		/>
	)
}

// ---- alt text --------------------------------------------------------------------------------------------

function AltTextDialog({ snapshot, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const drawing = snapshot?.context.drawing ?? null

	return (
		<InputDialog
			open
			pending={false}
			title={t("previewDocxAltTextTitle")}
			body={t("previewDocxAltTextDescription")}
			label={t("previewDocxAltTextLabel")}
			initialValue={drawing?.altText ?? ""}
			submitLabel={t("previewDocxApplyAction")}
			validate={text =>
				drawing !== null && enabled("drawing.altText") && parseDocxEditorCommand({ type: "drawing.altText", text }) !== undefined
			}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={text => {
				run({ type: "drawing.altText", text })
				close()
			}}
		/>
	)
}

// ---- links -----------------------------------------------------------------------------------------------

const BOOKMARK_PLACE = "bookmark:"
const HEADING_PLACE = "heading:"

// The heading (its place value) a link's hidden bookmark marks: a link to a heading goes to a _Toc bookmark
// there (link.set with `heading` makes or reuses it).
function headingOfAnchor(editor: PagedEditor, anchor: string, headings: readonly ChoiceOption[]): string | undefined {
	const session = editor.body.session
	const bookmark = sessionBookmarks(session).byName.get(anchor.toLowerCase())

	if (bookmark === undefined || !bookmark.hidden || bookmark.start !== "inline") {
		return undefined
	}

	const value = `${HEADING_PLACE}${String(session.state.doc.resolve(bookmark.startPos).before())}`

	return headings.some(heading => heading.value === value) ? value : undefined
}

// The link.set to a place: a heading by its paragraph's position, or a bookmark by name.
function placeLink(place: string, extra: { text?: string }): object {
	return place.startsWith(HEADING_PLACE)
		? { type: "link.set", heading: Number(place.slice(HEADING_PLACE.length)), ...extra }
		: { type: "link.set", anchor: place.slice(BOOKMARK_PLACE.length), ...extra }
}

function LinkDialog({ editor, snapshot, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const link = snapshot?.context.link ?? null
	const body = editor.activeStory === editor.body.session.story.story.index
	// Read once, as the dialog opens (never per keystroke).
	const [places] = useState(() => {
		const headings = body
			? docxOutline(editor)
					// A heading without text has nothing a link could show.
					.entries.filter(entry => entry.text.trim() !== "")
					.map(entry => ({ value: `${HEADING_PLACE}${String(entry.pos)}`, label: entry.text }))
			: []
		// Names a link can go to (link.set takes ASCII names).
		const bookmarks = docxBookmarks(editor)
			.filter(bookmark => parseDocxEditorCommand({ type: "link.set", anchor: bookmark.name }) !== undefined)
			.map(bookmark => ({ value: `${BOOKMARK_PLACE}${bookmark.name}`, label: bookmark.name }))

		const anchor = link?.anchor ?? null
		const initial =
			anchor === null
				? (headings[0]?.value ?? bookmarks[0]?.value ?? "")
				: (headingOfAnchor(editor, anchor, headings) ?? `${BOOKMARK_PLACE}${anchor}`)

		return { headings, bookmarks, initial }
	})
	const [showText] = useState(() => link !== null || editor.selection().empty)
	const [kind, setKind] = useState(link?.anchor == null ? "web" : "place")
	const [text, setText] = useState(link?.text ?? "")
	const [address, setAddress] = useState(link?.target ?? "")
	const [place, setPlace] = useState(places.initial)
	// The link's own target, while its address is untouched, goes back verbatim (a relative path or an app's scheme is
	// never read as a typed web address); a new address goes only to the web, email or a phone.
	const target = link !== null && link.target !== null && address === link.target ? link.target : linkTarget(address)
	const refusal = target === null ? undefined : linkTargetRefusal(target, link?.target)
	const shownText = showText && text.trim() !== "" ? text : undefined
	const extra = shownText === undefined ? {} : { text: shownText }
	const valid =
		enabled("link.set") &&
		(kind === "web"
			? target !== null && refusal === undefined && parseDocxEditorCommand({ type: "link.set", target, ...extra }) !== undefined
			: parseDocxEditorCommand(placeLink(place, extra)) !== undefined)
	const textId = useId()
	const addressId = useId()
	const addressErrorId = useId()

	const submit = (): void => {
		if (!valid) {
			return
		}

		run(kind === "web" ? { type: "link.set", target, ...extra } : placeLink(place, extra))

		close()
	}

	const noPlaces = places.headings.length === 0 && places.bookmarks.length === 0

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxLinkTitle")}
			description={t("previewDocxLinkDescription")}
			submitLabel={link === null ? t("previewDocxInsertAction") : t("previewDocxApplyAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, submit)
			}}
		>
			{showText ? (
				<Field>
					<FieldLabel htmlFor={textId}>{t("previewDocxLinkText")}</FieldLabel>
					<Input
						id={textId}
						value={text}
						maxLength={1024}
						onChange={event => {
							setText(event.target.value)
						}}
					/>
				</Field>
			) : null}
			<DocxChoiceField
				label={t("previewDocxLinkKind")}
				value={kind}
				items={[
					{ value: "web", label: t("previewDocxLinkWeb") },
					{ value: "place", label: t("previewDocxLinkPlace") }
				]}
				onChange={setKind}
			/>
			{kind === "web" ? (
				<Field>
					<FieldLabel htmlFor={addressId}>{t("previewDocxLinkAddress")}</FieldLabel>
					<Input
						id={addressId}
						value={address}
						autoFocus
						inputMode="url"
						placeholder="https://"
						maxLength={2048}
						aria-invalid={refusal === "scheme" ? true : undefined}
						aria-describedby={refusal === "scheme" ? addressErrorId : undefined}
						onChange={event => {
							setAddress(event.target.value)
						}}
					/>
					{refusal === "scheme" ? <FieldError id={addressErrorId}>{t("previewDocxLinkSchemeRefused")}</FieldError> : null}
				</Field>
			) : noPlaces ? (
				<p className="text-sm text-muted-foreground">{t("previewDocxLinkNoPlaces")}</p>
			) : (
				<PlaceSelect
					value={place}
					places={places}
					onChange={setPlace}
				/>
			)}
			{link !== null && enabled("link.remove") ? (
				<Button
					type="button"
					variant="outline"
					className="self-start"
					onClick={() => {
						run({ type: "link.remove" })
						close()
					}}
				>
					{t("previewDocxRemoveLink")}
				</Button>
			) : null}
		</FormDialog>
	)
}

function PlaceSelect({
	value,
	places,
	onChange
}: {
	value: string
	places: { headings: readonly ChoiceOption[]; bookmarks: readonly ChoiceOption[] }
	onChange: (value: string) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()

	return (
		<Field>
			<FieldLabel htmlFor={id}>{t("previewDocxLinkPlaceLabel")}</FieldLabel>
			<Select
				items={[...places.headings, ...places.bookmarks]}
				value={value}
				onValueChange={next => {
					if (typeof next === "string") {
						onChange(next)
					}
				}}
			>
				<SelectTrigger
					id={id}
					className="w-full"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent data-preview-surface>
					{places.headings.length === 0 ? null : (
						<SelectGroup>
							<SelectLabel>{t("previewDocxLinkHeadings")}</SelectLabel>
							{places.headings.map(option => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectGroup>
					)}
					{places.bookmarks.length === 0 ? null : (
						<SelectGroup>
							<SelectLabel>{t("previewDocxLinkBookmarks")}</SelectLabel>
							{places.bookmarks.map(option => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectGroup>
					)}
				</SelectContent>
			</Select>
		</Field>
	)
}

// ---- symbols ---------------------------------------------------------------------------------------------

// How Word's formatting marks show the characters that are otherwise invisible or look like others.
const FORMATTING_MARKS: Readonly<Record<string, string>> = { "\u00a0": "°", "\u2011": "‑", "\u00ad": "¬" }

function SymbolDialog({ enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const [text, setText] = useState("")
	const allowed = enabled("insert.symbol")
	const valid = allowed && parseDocxEditorCommand({ type: "insert.symbol", text }) !== undefined
	const id = useId()
	const insert = (value: string): void => {
		if (run({ type: "insert.symbol", text: value })) {
			close()
		}
	}

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxSymbolTitle")}
			description={t("previewDocxSymbolDescription")}
			submitLabel={t("previewDocxInsertAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			wide
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, () => {
					if (valid) {
						insert(text)
					}
				})
			}}
		>
			<div
				role="group"
				aria-label={t("previewDocxSymbolGrid")}
				className="grid grid-cols-8 gap-1"
			>
				{SYMBOLS.map(symbol => {
					const named = NAMED_SYMBOLS[symbol]

					return (
						<Button
							key={symbol}
							type="button"
							variant="outline"
							size="sm"
							disabled={!allowed}
							aria-label={named === undefined ? symbol : t(named)}
							title={named === undefined ? undefined : t(named)}
							className={cn("h-9 px-0 text-base", named !== undefined && "text-xs text-muted-foreground")}
							onClick={() => {
								insert(symbol)
							}}
						>
							{named === undefined ? symbol : FORMATTING_MARKS[symbol]}
						</Button>
					)
				})}
			</div>
			<Field>
				<FieldLabel htmlFor={id}>{t("previewDocxSymbolCharacters")}</FieldLabel>
				<Input
					id={id}
					value={text}
					maxLength={16}
					onChange={event => {
						setText(event.target.value)
					}}
				/>
			</Field>
		</FormDialog>
	)
}

// ---- dates -----------------------------------------------------------------------------------------------

// Word's Date and Time: the formats of the caret's language, previewed in it; the date inserted as text unless
// it updates automatically (a DATE field).
function DateDialog({ editor, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	// Read as the dialog opens: the previews show that moment.
	const [now] = useState(() => Date.now())
	const [{ language, pictures }] = useState(() => {
		const caret = caretLanguage(editor)

		return { language: caret, pictures: datePictures(caret) }
	})
	const [format, setFormat] = useState(pictures[0] ?? "M/d/yyyy")
	const [field, setField] = useState(false)
	const labelId = useId()
	const fieldId = useId()
	const valid = enabled("insert.date")

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxDateTitle")}
			description={t("previewDocxDateDescription")}
			submitLabel={t("previewDocxInsertAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, () => {
					if (valid && run({ type: "insert.date", format, field })) {
						close()
					}
				})
			}}
		>
			<Label
				id={labelId}
				className="sr-only"
			>
				{t("previewDocxDateFormats")}
			</Label>
			<RadioGroup
				aria-labelledby={labelId}
				value={format}
				className="max-h-72 gap-1 overflow-y-auto"
				onValueChange={(value: unknown) => {
					if (typeof value === "string") {
						setFormat(value)
					}
				}}
			>
				{pictures.map(picture => (
					<Label
						key={picture}
						className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-accent"
					>
						<RadioGroupItem value={picture} />
						<span className="truncate">{formatDatePicture(now, picture, language)}</span>
					</Label>
				))}
			</RadioGroup>
			<Field orientation="horizontal">
				<FieldLabel htmlFor={fieldId}>{t("previewDocxDateUpdateAutomatically")}</FieldLabel>
				<Switch
					id={fieldId}
					checked={field}
					onCheckedChange={setField}
				/>
			</Field>
		</FormDialog>
	)
}

// ---- tables of contents ----------------------------------------------------------------------------------

const TOC_LEVELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

function TocDialog({ enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const [levels, setLevels] = useState("3")
	const [hyperlinks, setHyperlinks] = useState(true)
	const id = useId()
	const valid = enabled("toc.insert")

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxTocTitle")}
			description={t("previewDocxTocDescription")}
			submitLabel={t("previewDocxInsertAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, () => {
					if (valid && run({ type: "toc.insert", levels: Number(levels), hyperlinks })) {
						close()
					}
				})
			}}
		>
			<DocxChoiceField
				label={t("previewDocxTocLevels")}
				value={levels}
				items={TOC_LEVELS.map(level => ({ value: level, label: level }))}
				onChange={setLevels}
			/>
			<Field orientation="horizontal">
				<FieldLabel htmlFor={id}>{t("previewDocxTocHyperlinks")}</FieldLabel>
				<Switch
					id={id}
					checked={hyperlinks}
					onCheckedChange={setHyperlinks}
				/>
			</Field>
		</FormDialog>
	)
}

// ---- fields ----------------------------------------------------------------------------------------------

function FieldDialog({ editor, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const [bookmark] = useState(() => docxBookmarks(editor)[0]?.name)
	const first = FIELD_CATALOGUE[0]
	const [type, setType] = useState(first?.type ?? "PAGE")
	const [code, setCode] = useState(fieldExample(first?.example ?? " PAGE ", bookmark))
	const id = useId()
	const parsed = parseDocxEditorCommand({ type: "insert.field", instruction: code }) !== undefined
	const valid = enabled("insert.field") && parsed
	const options = FIELD_CATALOGUE.map(entry => {
		const key = fieldNameKey(entry.type)

		return { value: entry.type, label: key === undefined ? entry.type : `${t(key)} (${entry.type})` }
	})

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxFieldTitle")}
			description={t("previewDocxFieldDescription")}
			submitLabel={t("previewDocxInsertAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, () => {
					if (valid && run({ type: "insert.field", instruction: code })) {
						close()
					}
				})
			}}
		>
			<DocxChoiceField
				label={t("previewDocxFieldType")}
				value={type}
				items={options}
				onChange={next => {
					setType(next)
					setCode(fieldExample(FIELD_CATALOGUE.find(entry => entry.type === next)?.example ?? "", bookmark))
				}}
			/>
			<Field data-invalid={parsed ? undefined : true}>
				<FieldLabel htmlFor={id}>{t("previewDocxFieldCode")}</FieldLabel>
				<Input
					id={id}
					value={code}
					maxLength={255}
					className="font-mono"
					aria-invalid={parsed ? undefined : true}
					onChange={event => {
						setCode(event.target.value)
					}}
				/>
				{parsed ? null : <FieldError>{t("previewDocxFieldCodeInvalid")}</FieldError>}
			</Field>
		</FormDialog>
	)
}

// ---- bookmarks -------------------------------------------------------------------------------------------

function BookmarkDialog({ editor, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	const [name, setName] = useState("")
	const [selected, setSelected] = useState<string | null>(null)
	// Bumped after each change, so the list is read again.
	const [version, setVersion] = useState(0)
	const [list, setList] = useState(() => docxBookmarks(editor))
	const [listVersion, setListVersion] = useState(version)
	const id = useId()

	if (listVersion !== version) {
		setListVersion(version)
		setList(docxBookmarks(editor))
	}

	const trimmed = name.trim()
	const taken = list.some(bookmark => bookmark.name.toLowerCase() === trimmed.toLowerCase())
	const validName = parseDocxEditorCommand({ type: "bookmark.add", name: trimmed }) !== undefined
	const error =
		trimmed === "" ? null : !validName ? t("previewDocxBookmarkNameInvalid") : taken ? t("previewDocxBookmarkNameTaken") : null
	const change = (value: object): void => {
		if (run(value)) {
			setVersion(previous => previous + 1)
			setName("")
			setSelected(null)
		}
	}
	const selectedBookmark = list.find(bookmark => bookmark.name === selected)
	const canAdd = validName && !taken && enabled("bookmark.add")

	return (
		<Dialog
			open
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("previewDocxBookmarkTitle")}</DialogTitle>
					<DialogDescription>{t("previewDocxBookmarkDescription")}</DialogDescription>
				</DialogHeader>
				{/* Enter adds the bookmark typed, as Word's Add. */}
				<form
					onSubmit={event => {
						event.preventDefault()

						if (canAdd) {
							change({ type: "bookmark.add", name: trimmed })
						}
					}}
				>
					<Field data-invalid={error === null ? undefined : true}>
						<FieldLabel htmlFor={id}>{t("previewDocxBookmarkName")}</FieldLabel>
						<Input
							id={id}
							value={name}
							autoFocus
							maxLength={40}
							aria-invalid={error === null ? undefined : true}
							onChange={event => {
								setName(event.target.value)
							}}
						/>
						{error === null ? null : <FieldError>{error}</FieldError>}
					</Field>
				</form>
				{list.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("previewDocxBookmarkNone")}</p>
				) : (
					<ul
						aria-label={t("previewDocxBookmarkList")}
						className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-xl border p-1"
					>
						{list.map(bookmark => (
							<li key={bookmark.name}>
								<button
									type="button"
									aria-pressed={selected === bookmark.name}
									className={cn(
										"w-full truncate rounded-lg px-2 py-1 text-left text-sm hover:bg-accent",
										selected === bookmark.name && "bg-accent text-accent-foreground"
									)}
									onClick={() => {
										setSelected(bookmark.name)
									}}
								>
									{bookmark.name}
								</button>
							</li>
						))}
					</ul>
				)}
				<DialogFooter className="flex-wrap">
					<Button
						type="button"
						variant="outline"
						disabled={selectedBookmark === undefined}
						onClick={() => {
							if (selectedBookmark === undefined) {
								return
							}

							if (editor.activeStory !== editor.body.session.story.story.index) {
								editor.exitStory()
							}

							editor.select({ pos: selectedBookmark.from, affinity: 1, page: 0, line: 0, atom: false })
							close()
						}}
					>
						{t("previewDocxBookmarkGoTo")}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={selectedBookmark === undefined || !enabled("bookmark.delete")}
						onClick={() => {
							change({ type: "bookmark.delete", name: selected })
						}}
					>
						{t("previewDocxBookmarkDeleteAction")}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={selectedBookmark === undefined || !validName || taken || !enabled("bookmark.rename")}
						onClick={() => {
							change({ type: "bookmark.rename", name: selected, to: trimmed })
						}}
					>
						{t("previewDocxBookmarkRenameAction")}
					</Button>
					<Button
						type="button"
						disabled={!canAdd}
						onClick={() => {
							change({ type: "bookmark.add", name: trimmed })
						}}
					>
						{t("previewDocxBookmarkAdd")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// ---- notes -----------------------------------------------------------------------------------------------

// What each number format looks like (numbers and symbols, the same in every language).
const FORMAT_SAMPLES: Readonly<Record<DocxNoteNumberFormat, string>> = {
	decimal: "1, 2, 3, …",
	upperRoman: "I, II, III, …",
	lowerRoman: "i, ii, iii, …",
	upperLetter: "A, B, C, …",
	lowerLetter: "a, b, c, …",
	chicago: "*, †, ‡, §, …",
	decimalEnclosedCircle: "①, ②, ③, …"
}

const POSITION_LABELS: Readonly<Record<DocxNotePosition, PreviewKey>> = {
	pageBottom: "previewDocxNotePageBottom",
	beneathText: "previewDocxNoteBeneathText",
	sectEnd: "previewDocxNoteSectionEnd",
	docEnd: "previewDocxNoteDocumentEnd"
}

const KIND_POSITIONS: Readonly<Record<DocxNoteKind, readonly DocxNotePosition[]>> = {
	footnote: ["pageBottom", "beneathText"],
	endnote: ["sectEnd", "docEnd"]
}

const RESTART_LABELS: Readonly<Record<DocxNoteRestart, PreviewKey>> = {
	continuous: "previewDocxNoteContinuous",
	eachSect: "previewDocxLineNumbersSection",
	eachPage: "previewDocxLineNumbersPage"
}

interface NoteValues {
	kind: DocxNoteKind
	position: string
	format: string
	start: string
	restart: string
}

function noteValues(editor: PagedEditor, kind: DocxNoteKind): NoteValues {
	const current = currentNoteOptions(editor, kind)

	return {
		kind,
		position: current.position,
		format: current.format ?? "",
		start: String(current.start),
		restart: current.restart
	}
}

function NoteOptionsDialog({ editor, snapshot, enabled, run, close }: DialogProps) {
	const { t } = useTranslation("preview")
	// The kind of note being edited, else footnotes (as Word's dialog opens).
	const [values, setValues] = useState(() => noteValues(editor, snapshot?.context.story.note?.kind ?? "footnote"))
	const [scope, setScope] = useState("section")
	const set = (patch: Partial<NoteValues>): void => {
		setValues(previous => ({ ...previous, ...patch }))
	}
	const command = {
		type: "note.options",
		kind: values.kind,
		scope,
		position: values.position,
		start: whole(values.start),
		restart: values.restart,
		...(values.format === "" ? {} : { format: values.format })
	}
	const valid = enabled("note.options") && parseDocxEditorCommand(command) !== undefined

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxNoteOptionsTitle")}
			description={t("previewDocxNoteOptionsDescription")}
			submitLabel={t("previewDocxApplyAction")}
			cancelLabel={t("previewDocxCancelAction")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				submitted(event, () => {
					if (valid && run(command)) {
						close()
					}
				})
			}}
		>
			<DocxChoiceField
				label={t("previewDocxNoteKind")}
				value={values.kind}
				items={[
					{ value: "footnote", label: t("previewDocxNoteKindFootnote") },
					{ value: "endnote", label: t("previewDocxNoteKindEndnote") }
				]}
				onChange={kind => {
					setValues(noteValues(editor, kind === "endnote" ? "endnote" : "footnote"))
				}}
			/>
			<DocxChoiceField
				label={t("previewDocxNoteLocation")}
				value={values.position}
				items={KIND_POSITIONS[values.kind].map(position => ({ value: position, label: t(POSITION_LABELS[position]) }))}
				onChange={position => {
					set({ position })
				}}
			/>
			<DocxChoiceField
				label={t("previewDocxNoteFormat")}
				value={values.format}
				items={DOCX_NOTE_NUMBER_FORMATS.map(format => ({ value: format, label: FORMAT_SAMPLES[format] }))}
				onChange={format => {
					set({ format })
				}}
			/>
			<div className="grid grid-cols-2 gap-4">
				<NumberField
					label={t("previewDocxNoteStart")}
					value={values.start}
					min={1}
					max={32767}
					onChange={start => {
						set({ start })
					}}
				/>
				<DocxChoiceField
					label={t("previewDocxNoteRestart")}
					value={values.restart}
					items={(values.kind === "footnote"
						? (["continuous", "eachSect", "eachPage"] as const)
						: (["continuous", "eachSect"] as const)
					).map(restart => ({ value: restart, label: t(RESTART_LABELS[restart]) }))}
					onChange={restart => {
						set({ restart })
					}}
				/>
			</div>
			<DocxChoiceField
				label={t("previewDocxApplyTo")}
				value={scope}
				items={[
					{ value: "section", label: t("previewDocxApplySection") },
					{ value: "document", label: t("previewDocxApplyDocument") }
				]}
				onChange={setScope}
			/>
		</FormDialog>
	)
}
