import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { newSheetName, type SheetCommand, type SheetCommandResult, type SheetId, type SheetSummary } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger
} from "@/components/ui/context-menu"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { useEscapeClosesMenu } from "@/features/spreadsheet/components/menuEscape"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { FormDialog } from "@/components/dialogs/formDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { TAB_COLORS, addedSheet, cssColor, moveTarget, nextShown } from "@/features/spreadsheet/tabs/sheetTabs.logic"
import { useProtection } from "@/features/spreadsheet/tabs/useProtection"
import { useSheetTabRequests } from "@/features/spreadsheet/tabs/tabRequests"

// One menu's parts: the tab's context menu (right click, long press) and its ⋯ button share the items.
interface MenuParts {
	readonly Item: ComponentType<{ disabled?: boolean; title?: string; onClick?: () => void; children?: ReactNode }>
	readonly Separator: ComponentType
	readonly Sub: ComponentType<{ children?: ReactNode }>
	readonly SubTrigger: ComponentType<{ disabled?: boolean; children?: ReactNode }>
	readonly SubContent: ComponentType<{ children?: ReactNode }>
}

const CONTEXT_PARTS: MenuParts = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent
}

const DROPDOWN_PARTS: MenuParts = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent
}

// Whether the workbook's structure is protected now: asked of the session after every change (one small query).
function useStructureLocked(grid: SheetGridState, wanted: boolean): boolean {
	const { model, sheet, state } = grid
	const [locked, setLocked] = useState<{ version: number; locked: boolean }>({ version: -1, locked: false })

	useEffect(() => {
		if (!wanted) {
			return undefined
		}

		let live = true

		model.session.query("commandState", { sheet, ranges: [], types: ["sheet.add"] }).then(
			result => {
				if (live) {
					setLocked({ version: state.version, locked: result.reasons[0] === "protectedWorkbook" })
				}
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [model, sheet, state.version, wanted])

	return wanted && locked.locked
}

// The workbook's sheets as tabs along the bottom edge (hidden ones left out), each with its colour. Arrow keys move
// between them (roving tabindex); F2 or a double click renames. Each tab's menu (right click, long press, or the
// active tab's ⋯ button) inserts, duplicates, renames, deletes, moves, hides, colours and protects; the workbook's
// structure protection turns the sheet changes off.
export function SheetTabs({ grid, canEdit, run }: { grid: SheetGridState; canEdit: boolean; run: (command: SheetCommand) => void }) {
	const { t } = useTranslation(["preview", "common"])
	const { model, sheets } = grid
	const shown = sheets.filter(sheet => sheet.state === "visible")
	const hidden = sheets.filter(sheet => sheet.state === "hidden")
	const activeIndex = Math.max(
		0,
		shown.findIndex(sheet => sheet.id === grid.sheet)
	)
	const locked = useStructureLocked(grid, canEdit)
	const structure = canEdit && !locked
	const protection = useProtection(model)
	const [renaming, setRenaming] = useState<SheetId | null>(null)
	const [deleting, setDeleting] = useState<SheetId | null>(null)
	const [unhiding, setUnhiding] = useState(false)
	const [unhideChoice, setUnhideChoice] = useState<SheetId | null>(null)
	// The tab whose menu is open.
	const [menuSheet, setMenuSheet] = useState<SheetId | null>(null)

	useEscapeClosesMenu(menuSheet !== null, () => {
		setMenuSheet(null)
	})
	const lockedTitle = locked ? t("previewSheetStructureProtected") : undefined

	// The ribbon's sheet commands, for the sheet on show, as its tab's menu runs them.
	useSheetTabRequests(model, request => {
		const sheetProtected = (model.layout(grid.sheet)?.protection ?? null) !== null

		switch (request) {
			case "rename":
				if (structure) setRenaming(grid.sheet)
				break
			case "delete":
				if (structure && shown.length > 1) setDeleting(grid.sheet)
				break
			case "protectSheet":
				if (!canEdit) break
				if (sheetProtected) protection.unprotect({ sheet: grid.sheet })
				else protection.protect({ sheet: grid.sheet })
				break
			case "protectWorkbook":
				if (!canEdit) break
				if (locked) protection.unprotect("workbook")
				else protection.protect("workbook")
				break
		}
	})

	function select(sheet: SheetId): void {
		if (sheet === grid.sheet) {
			return
		}

		void model.commitEditing(null).then(done => {
			if (done) {
				model.setSheet(sheet)
			}
		})
	}

	// Runs a command that adds a sheet, and shows the sheet it added.
	function addAndShow(command: SheetCommand): void {
		const before = model.getSnapshot().sheets

		void model.intent()
		void model.command(command).then(
			(result: SheetCommandResult) => {
				const added = result.ok ? addedSheet(before, result.change.sheets) : null

				if (added !== null) {
					model.setSheet(added)
				}
			},
			() => undefined
		)
	}

	function insertAfter(sheet: SheetId): void {
		const index = sheets.findIndex(entry => entry.id === sheet)

		addAndShow({
			type: "sheet.add",
			name: newSheetName(
				sheets.map(entry => entry.name),
				number => t("previewSpreadsheetNewSheetName", { number })
			),
			index: index + 1
		})
	}

	function hide(sheet: SheetId): void {
		const next = nextShown(sheets, sheet)

		if (next === null) {
			return
		}

		if (sheet === grid.sheet) {
			select(next)
		}

		run({ type: "sheet.state", sheet, state: "hidden" })
	}

	function items(summary: SheetSummary, parts: MenuParts): ReactNode {
		const { Item, Separator, Sub, SubTrigger, SubContent } = parts
		const sheet = summary.id
		const left = moveTarget(sheets, sheet, -1)
		const right = moveTarget(sheets, sheet, 1)
		const sheetProtected = (model.layout(sheet)?.protection ?? null) !== null

		return (
			<>
				<Item
					disabled={!structure}
					{...(lockedTitle !== undefined && { title: lockedTitle })}
					onClick={() => {
						insertAfter(sheet)
					}}
				>
					{t("previewSheetInsertSheet")}
				</Item>
				<Item
					disabled={!structure}
					{...(lockedTitle !== undefined && { title: lockedTitle })}
					onClick={() => {
						addAndShow({ type: "sheet.duplicate", sheet })
					}}
				>
					{t("previewSheetDuplicate")}
				</Item>
				<Item
					disabled={!structure}
					{...(lockedTitle !== undefined && { title: lockedTitle })}
					onClick={() => {
						setRenaming(sheet)
					}}
				>
					{t("previewSheetRename")}
				</Item>
				<Item
					disabled={!structure || shown.length < 2}
					{...(lockedTitle !== undefined && { title: lockedTitle })}
					onClick={() => {
						setDeleting(sheet)
					}}
				>
					{t("previewSheetDelete")}
				</Item>
				<Separator />
				<Item
					disabled={!structure || left === null}
					onClick={() => {
						if (left !== null) {
							run({ type: "sheet.move", sheet, to: left })
						}
					}}
				>
					{t("previewSheetMoveLeft")}
				</Item>
				<Item
					disabled={!structure || right === null}
					onClick={() => {
						if (right !== null) {
							run({ type: "sheet.move", sheet, to: right })
						}
					}}
				>
					{t("previewSheetMoveRight")}
				</Item>
				<Item
					disabled={!structure || shown.length < 2}
					onClick={() => {
						hide(sheet)
					}}
				>
					{t("previewSheetHide")}
				</Item>
				<Item
					disabled={!structure || hidden.length === 0}
					onClick={() => {
						setUnhideChoice(hidden[0]?.id ?? null)
						setUnhiding(true)
					}}
				>
					{t("previewSheetUnhide")}
				</Item>
				<Sub>
					<SubTrigger disabled={!structure}>{t("previewSheetTabColor")}</SubTrigger>
					<SubContent>
						{TAB_COLORS.map(color => (
							<Item
								key={color.rgb}
								onClick={() => {
									run({ type: "sheet.tabColor", sheet, color: color.rgb })
								}}
							>
								<span
									aria-hidden
									className="size-3.5 rounded-sm ring-1 ring-border"
									style={{ backgroundColor: cssColor(color.rgb) }}
								/>
								{t(color.key)}
								{summary.tabColor === color.rgb ? <CheckIcon className="ml-auto" /> : null}
							</Item>
						))}
						<Separator />
						<Item
							disabled={summary.tabColor === undefined}
							onClick={() => {
								run({ type: "sheet.tabColor", sheet, color: null })
							}}
						>
							{t("previewSheetTabColorNone")}
						</Item>
					</SubContent>
				</Sub>
				<Separator />
				<Item
					disabled={!canEdit}
					onClick={() => {
						if (sheetProtected) {
							protection.unprotect({ sheet })
						} else {
							protection.protect({ sheet })
						}
					}}
				>
					{t(sheetProtected ? "previewSheetUnprotect" : "previewSheetProtect")}
				</Item>
				<Item
					disabled={!canEdit}
					onClick={() => {
						if (locked) {
							protection.unprotect("workbook")
						} else {
							protection.protect("workbook")
						}
					}}
				>
					{t(locked ? "previewSheetUnprotectWorkbook" : "previewSheetProtectWorkbook")}
				</Item>
			</>
		)
	}

	const deletingName = sheets.find(sheet => sheet.id === deleting)?.name ?? ""

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-t border-border bg-muted/40 px-2">
			{canEdit ? (
				<TooltipIconButton
					label={t("previewSpreadsheetAddSheet")}
					disabled={!structure}
					onClick={() => {
						insertAfter(sheets.at(-1)?.id ?? grid.sheet)
					}}
				>
					<PlusIcon />
				</TooltipIconButton>
			) : null}
			<div
				role="tablist"
				aria-label={t("previewSpreadsheetSheets")}
				className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
				onKeyDown={event => {
					if (event.key === "F2" && structure) {
						event.preventDefault()
						setRenaming(shown[activeIndex]?.id ?? null)

						return
					}

					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
						return
					}

					event.preventDefault()

					const next = (activeIndex + (event.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length
					const target = shown[next]

					if (target !== undefined) {
						select(target.id)
					}

					event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus()
				}}
			>
				{shown.map((sheet, index) => {
					const active = index === activeIndex

					return (
						<div
							key={sheet.id}
							className="flex shrink-0 items-center"
						>
							<ContextMenu
								open={menuSheet === sheet.id}
								onOpenChange={open => {
									setMenuSheet(current => (open ? sheet.id : current === sheet.id ? null : current))
								}}
							>
								<ContextMenuTrigger
									render={
										<button
											type="button"
											role="tab"
											aria-selected={active}
											tabIndex={active ? 0 : -1}
											className={cn(
												"relative h-7 shrink-0 rounded-md px-3 text-xs whitespace-nowrap focus-ring transition-colors",
												active
													? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border"
													: "text-muted-foreground hover:bg-accent/60"
											)}
											onClick={() => {
												select(sheet.id)
											}}
											onDoubleClick={() => {
												if (structure) {
													setRenaming(sheet.id)
												}
											}}
										>
											{sheet.name}
											{sheet.tabColor === undefined ? null : (
												<span
													aria-hidden
													data-tab-color
													className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-full"
													style={{ backgroundColor: cssColor(sheet.tabColor) }}
												/>
											)}
										</button>
									}
								/>
								<ContextMenuContent aria-label={t("previewSheetTabMenu")}>{items(sheet, CONTEXT_PARTS)}</ContextMenuContent>
							</ContextMenu>
							{active ? (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-xs"
												aria-label={t("previewSheetTabMenu")}
												className="shrink-0"
											>
												<MoreHorizontalIcon />
											</Button>
										}
									/>
									<DropdownMenuContent data-preview-surface>{items(sheet, DROPDOWN_PARTS)}</DropdownMenuContent>
								</DropdownMenu>
							) : null}
						</div>
					)
				})}
			</div>
			<InputDialog
				open={structure && renaming !== null}
				pending={false}
				title={t("previewSpreadsheetRenameSheet")}
				body={t("previewSpreadsheetRenameSheetBody")}
				label={t("previewSpreadsheetSheetName")}
				initialValue={sheets.find(sheet => sheet.id === renaming)?.name ?? ""}
				submitLabel={t("previewSpreadsheetRenameSheet")}
				validate={value => value.trim().length > 0}
				onOpenChange={open => {
					if (!open) {
						setRenaming(null)
					}
				}}
				onSubmit={value => {
					if (renaming !== null) {
						run({ type: "sheet.rename", sheet: renaming, name: value })
					}

					setRenaming(null)
				}}
			/>
			<ConfirmDialog
				open={deleting !== null}
				pending={false}
				destructive
				title={t("previewSheetDeleteTitle")}
				body={t("previewSheetDeleteBody", { name: deletingName })}
				confirmLabel={t("previewSheetDelete")}
				cancelLabel={t("common:cancel")}
				onOpenChange={open => {
					if (!open) {
						setDeleting(null)
					}
				}}
				onConfirm={() => {
					if (deleting !== null) {
						if (deleting === grid.sheet) {
							const next = nextShown(sheets, deleting)

							if (next !== null) {
								select(next)
							}
						}

						run({ type: "sheet.delete", sheet: deleting })
					}

					setDeleting(null)
				}}
			/>
			<FormDialog
				open={unhiding}
				pending={false}
				title={t("previewSheetUnhideTitle")}
				description={t("previewSheetUnhideBody")}
				submitLabel={t("previewSheetUnhideAction")}
				cancelLabel={t("common:cancel")}
				canSubmit={unhideChoice !== null}
				onOpenChange={setUnhiding}
				onSubmit={event => {
					event.preventDefault()

					if (unhideChoice !== null) {
						const sheet = unhideChoice

						void model.intent()
						void model.command({ type: "sheet.state", sheet, state: "visible" }).then(
							result => {
								if (result.ok) {
									model.setSheet(sheet)
								}
							},
							() => undefined
						)
					}

					setUnhiding(false)
				}}
			>
				<div
					role="radiogroup"
					aria-label={t("previewSheetUnhideTitle")}
					className="flex max-h-64 flex-col gap-1 overflow-y-auto"
				>
					{hidden.map(sheet => (
						<label
							key={sheet.id}
							className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
						>
							<input
								type="radio"
								name="sheet-unhide"
								className="size-4 accent-primary"
								checked={unhideChoice === sheet.id}
								onChange={() => {
									setUnhideChoice(sheet.id)
								}}
							/>
							{sheet.name}
						</label>
					))}
				</div>
			</FormDialog>
			{protection.dialogs}
		</div>
	)
}
