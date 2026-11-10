import { isImeKeydown } from "@filen/shared/keymap"
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, PlusIcon, XIcon } from "lucide-react"
import { MAX_CONTROL_ITEM, type DocxControlItemInput, type DocxEditorCommand, type DocxEditorSnapshot } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import {
	controlLockedKey,
	TYPE_AHEAD_MS,
	typeAhead,
	useInputForm,
	type DocxInputChannelProps,
	type DocxSurface
} from "@/features/preview/components/docxEditor.logic"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useLatestRef } from "@/lib/useLatestRef"

// What the components acting on objects in the document get (form controls, equations, fields and notes,
// comment popovers), on either surface.
export interface DocxObjectControlProps extends DocxInputChannelProps {
	editor: PagedEditor
	// The toolbar's snapshot (what is enabled; it changes only with what the toolbar shows).
	snapshot: DocxEditorSnapshot | undefined
	surface: DocxSurface
	// The element the document is shown in, pages or reflowed (popovers anchor in it).
	container: HTMLDivElement | null
	zoom: number
	readOnly: boolean
	execute: (command: DocxEditorCommand) => void
	// The last press on an object of a feature offered (DocxEditor `interactions`), until dismissed.
	press: DocxObjectPress | null
	onPressDone: () => void
}

// Content controls in the document, filled in where they are: a press on a checkbox ticks it, on a dropdown
// list opens its items (a listbox: arrows, Home, End, Enter), whose entries are added and removed there too
// (Word's Properties), on a date control a date picker; each picker can clear the control. A control that
// cannot change says why. Insert ▸ Form control ▸ Dropdown list asks here for the new list's items.

// Puts the caret in the pressed control (the form commands act on the selection's): at the press on the pages,
// at the control in the reflowed view (a press there has no page).
function placeCaret(editor: PagedEditor, press: DocxObjectPress): void {
	const hit = press.page >= 0 ? editor.hitTest(press.page, press.x, press.y) : undefined

	editor.select(hit ?? { pos: press.hit.pos, affinity: 1, page: Math.max(0, press.page), line: 0, atom: false })
}

const TODAY_ISO_LENGTH = 10

function today(): string {
	const now = new Date()

	return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, TODAY_ISO_LENGTH)
}

export function DocxFormControls({ editor, snapshot, readOnly, execute, press, onPressDone, ...channel }: DocxObjectControlProps) {
	const { t } = useTranslation("preview")
	// The press whose popover was closed, and the date typed for a press: both go with the press.
	const [closed, setClosed] = useState<DocxObjectPress | null>(null)
	const [typed, setTyped] = useState<{ press: DocxObjectPress; date: string } | null>(null)
	const [editing, setEditing] = useState<DocxObjectPress | null>(null)
	const control = snapshot?.context.control ?? null
	// What the press's effect uses as it is now (it runs once per press).
	const latest = useLatestRef({ readOnly, execute, onPressDone })
	const listRef = useRef<HTMLDivElement | null>(null)

	// A press puts the caret in its control; a checkbox that can change is ticked at once.
	useEffect(() => {
		if (press === null) {
			return
		}

		// From the keyboard (Alt+Down) the caret is in the control already.
		if (press.pointerType !== "keyboard") {
			placeCaret(editor, press)
		}

		const at = editor.snapshot()
		const now = latest.current

		if (press.hit.part === "checkbox" && !now.readOnly && at.context.control?.locked === null && at.enabled["control.check"]) {
			now.execute({ type: "control.check" })
			now.onPressDone()
		}
	}, [press, editor, latest])

	const why = readOnly ? t("previewDocxControlLockedReadOnly") : control?.locked != null ? t(controlLockedKey(control.locked)) : null
	const shown = press !== null && closed !== press ? press : null
	const open = shown !== null && control !== null && (shown.hit.part !== "checkbox" || why !== null)
	const enabled = snapshot?.enabled
	const date = typed !== null && typed.press === press ? typed.date : ""
	const close = (): void => {
		setClosed(press)
		onPressDone()
	}
	const run = (command: DocxEditorCommand): void => {
		execute(command)
		close()
	}
	const itemsEditable = why === null && control?.kind === "control" && enabled?.["control.items"] === true

	return (
		<>
			{open ? (
				<Popover
					open
					onOpenChange={next => {
						if (!next) {
							close()
						}
					}}
				>
					<PopoverTrigger
						nativeButton={false}
						render={
							<span
								aria-hidden="true"
								className="pointer-events-none fixed size-px"
								// At the press (or the caret, from the keyboard), in the window.
								style={{ left: shown.clientX, top: shown.clientY }}
							/>
						}
					/>
					<PopoverContent
						align="start"
						aria-label={
							control.title ??
							t(
								shown.hit.part === "date"
									? "previewDocxControlDate"
									: shown.hit.part === "checkbox"
										? "previewDocxControlCheck"
										: "previewDocxControlChoose"
							)
						}
						data-preview-surface
						data-docx-control-popover=""
						initialFocus={shown.hit.part === "list" ? listRef : true}
						className="w-64 gap-2 p-2"
					>
						{control.title === null ? null : (
							<p className="px-2 pt-1 text-xs font-medium text-muted-foreground">{control.title}</p>
						)}
						{why !== null ? (
							<p
								role="status"
								className="px-2 py-1 text-muted-foreground"
							>
								{why}
							</p>
						) : null}
						{shown.hit.part === "list" ? (
							<ControlListbox
								items={control.items}
								value={control.placeholder ? null : control.value}
								disabled={why !== null || enabled?.["control.choose"] !== true}
								onChoose={value => {
									run({ type: "control.choose", value })
								}}
								listRef={listRef}
							/>
						) : null}
						{shown.hit.part === "list" && itemsEditable ? (
							editing === shown ? (
								<ItemsEditor
									items={control.items}
									onChange={items => {
										execute({ type: "control.items", items })
									}}
								/>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className="justify-start"
									onClick={() => {
										setEditing(shown)
									}}
								>
									{t("previewDocxControlItemsEdit")}
								</Button>
							)
						) : null}
						{shown.hit.part === "date" ? (
							<form
								className="flex flex-col gap-2 px-2"
								onSubmit={event => {
									event.preventDefault()

									const iso = date === "" ? (control.date ?? today()) : date

									run({ type: "control.date", iso })
								}}
							>
								<Field>
									<FieldLabel htmlFor="docx-control-date">{t("previewDocxControlDateLabel")}</FieldLabel>
									<Input
										id="docx-control-date"
										type="date"
										disabled={why !== null}
										value={date === "" ? (control.date ?? today()) : date}
										onChange={event => {
											setTyped({ press: shown, date: event.target.value })
										}}
									/>
								</Field>
								<Button
									type="submit"
									size="sm"
									disabled={why !== null || enabled?.["control.date"] !== true}
								>
									{t("previewDocxControlDateSet")}
								</Button>
							</form>
						) : null}
						{why === null && shown.hit.part !== "checkbox" ? (
							<Button
								variant="ghost"
								size="sm"
								className="justify-start"
								disabled={enabled?.["control.clear"] !== true || control.placeholder}
								onClick={() => {
									run({ type: "control.clear" })
								}}
							>
								<XIcon />
								{t("previewDocxControlClear")}
							</Button>
						) : null}
					</PopoverContent>
				</Popover>
			) : null}
			<DocxDropdownInsertDialog
				execute={execute}
				{...channel}
			/>
		</>
	)
}

// A list's entries as a listbox (ARIA APG listbox: one tab stop, the active option followed with the arrow
// keys, Home, End and type-ahead and kept in view, chosen with Enter or Space or a click).
function ControlListbox({
	items,
	value,
	disabled,
	onChoose,
	listRef
}: {
	items: readonly { readonly text: string; readonly value: string }[]
	value: string | null
	disabled: boolean
	onChoose: (value: string) => void
	// Focused as the popover opens.
	listRef: RefObject<HTMLDivElement | null>
}) {
	const { t } = useTranslation("preview")
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			items.findIndex(item => item.value === value)
		)
	)
	const at = Math.min(active, items.length - 1)
	const id = useId()
	// The type-ahead typed so far and when its last character was.
	const typed = useRef({ query: "", time: 0 })
	const typing = (now: number): boolean => typed.current.query !== "" && now - typed.current.time <= TYPE_AHEAD_MS
	// The active option moves, kept in view in a list taller than the popover.
	const move = (index: number): void => {
		setActive(index)
		document.getElementById(`${id}-${String(index)}`)?.scrollIntoView({ block: "nearest" })
	}
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
		const now = Date.now()

		if (event.key in step) {
			move(Math.max(0, Math.min(items.length - 1, at + (step[event.key] ?? 0))))
		} else if (event.key === "Home") {
			move(0)
		} else if (event.key === "End") {
			move(items.length - 1)
		} else if ((event.key === "Enter" || (event.key === " " && !typing(now))) && !disabled) {
			const item = items[at]

			if (item !== undefined) {
				onChoose(item.value)
			}
		} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			// Type-ahead: characters typed in quick succession add up (a space too, once typing).
			const query = (typing(now) ? typed.current.query : "") + event.key
			const next = typeAhead(
				items.map(item => item.text),
				at,
				query
			)

			typed.current = { query, time: now }

			if (next >= 0) {
				move(next)
			}
		} else {
			return
		}

		event.preventDefault()
	}

	return (
		<div
			role="listbox"
			aria-label={t("previewDocxControlItems")}
			aria-activedescendant={items.length === 0 ? undefined : `${id}-${String(at)}`}
			aria-disabled={disabled}
			ref={listRef}
			tabIndex={0}
			className="flex max-h-64 flex-col overflow-y-auto rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onKeyDown={onKeyDown}
		>
			{items.map((item, index) => (
				<div
					key={index}
					id={`${id}-${String(index)}`}
					role="option"
					aria-selected={value === item.value}
					data-active={index === at ? "" : undefined}
					className="flex cursor-default items-center gap-2 rounded-xl px-2 py-1.5 text-sm data-[active]:bg-accent"
					onPointerEnter={() => {
						setActive(index)
					}}
					onClick={() => {
						if (!disabled) {
							onChoose(item.value)
						}
					}}
				>
					<CheckIcon className={value === item.value ? "size-4" : "invisible size-4"} />
					{item.text}
				</div>
			))}
		</div>
	)
}

// A list's entries, added and removed (the new dropdown's dialog and a dropdown's popover). A new entry's value
// is its text, as Word gives it; Word refuses an entry whose text or value another has.
function ItemsEditor({
	items,
	onChange
}: {
	items: readonly DocxControlItemInput[]
	onChange: (items: readonly DocxControlItemInput[]) => void
}) {
	const { t } = useTranslation("preview")
	const [typed, setTyped] = useState("")
	const field = useRef<HTMLInputElement | null>(null)
	const next = typed.trim()
	const duplicate = items.some(item => item.text === next || item.value === next)
	// The field keeps focus for the next entry (a change in the document moves it to the document).
	const change = (list: readonly DocxControlItemInput[]): void => {
		onChange(list)
		field.current?.focus()
	}
	const add = (): void => {
		if (next !== "" && !duplicate) {
			change([...items, { text: next, value: next }])
			setTyped("")
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<Field data-invalid={duplicate}>
				<FieldLabel htmlFor="docx-dropdown-item">{t("previewDocxDropdownItem")}</FieldLabel>
				<div className="flex gap-2">
					<Input
						ref={field}
						id="docx-dropdown-item"
						maxLength={MAX_CONTROL_ITEM}
						value={typed}
						aria-invalid={duplicate}
						onChange={event => {
							setTyped(event.target.value)
						}}
						onKeyDown={event => {
							if (event.key === "Enter" && !isImeKeydown(event.nativeEvent)) {
								event.preventDefault()
								add()
							}
						}}
					/>
					<Button
						type="button"
						variant="outline"
						disabled={next === "" || duplicate}
						onClick={add}
					>
						<PlusIcon data-icon="inline-start" />
						{t("previewDocxDropdownAdd")}
					</Button>
				</div>
				{duplicate ? <FieldError>{t("previewDocxDropdownDuplicate")}</FieldError> : null}
			</Field>
			{items.length > 0 ? (
				<ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
					{items.map((item, index) => (
						<li
							key={index}
							className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1"
						>
							<span className="truncate">{item.text}</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={t("previewDocxDropdownRemove", { item: item.text })}
								onClick={() => {
									change(items.filter((_, other) => other !== index))
								}}
							>
								<XIcon />
							</Button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}

// Insert ▸ Form control ▸ Dropdown list: the new list's items, added and removed, then inserted.
function DocxDropdownInsertDialog({
	execute,
	inputRequest,
	onInputDone
}: Pick<DocxObjectControlProps, "execute" | "inputRequest" | "onInputDone" | "requestInput">) {
	const { t } = useTranslation(["preview", "common"])
	const {
		request,
		form: items,
		setForm
	} = useInputForm<readonly DocxControlItemInput[]>(
		inputRequest,
		asked => asked.type === "control.insert" && asked.detail === "dropDownList",
		() => []
	)

	if (request === null || items === null) {
		return null
	}

	const close = (): void => {
		onInputDone(request.nonce)
	}

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewDocxDropdownTitle")}
			description={t("previewDocxDropdownBody")}
			submitLabel={t("previewDocxDropdownInsert")}
			cancelLabel={t("common:cancel")}
			canSubmit={items.length > 0}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={(event: SubmitEvent) => {
				event.preventDefault()
				execute({ type: "control.insert", kind: "dropDownList", items })
				close()
			}}
		>
			<ItemsEditor
				items={items}
				onChange={next => {
					setForm(() => next)
				}}
			/>
		</FormDialog>
	)
}
