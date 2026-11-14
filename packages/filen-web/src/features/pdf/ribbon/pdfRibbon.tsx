import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, PanelLeftIcon, Redo2Icon, Undo2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { MenuShortcut } from "@/components/ui/menuShortcut"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { OfficeRibbon, type RibbonGroup, type RibbonTab } from "@/features/office/components/ribbon/officeRibbon"
import { useCoarsePointer } from "@/features/office/components/ribbon/phoneMedia"
import { keepFocus } from "@/features/office/lib/officeControls"
import { BAR_BUTTON } from "@/features/preview/components/commandBar.logic"
import { usePdfCommandParts, type PdfCommandBarProps } from "@/features/preview/components/pdfCommandParts"
import {
	PDF_RIBBON_TABS,
	toolVariant,
	type PdfPolicyState,
	type PdfRibbonTab,
	type PdfTool,
	type PdfToolContext
} from "@/features/pdf/tools/registry"
import {
	nextActiveTool,
	pdfRibbonTab,
	pdfToolControl,
	pdfToolGroupLabelKey,
	pdfToolGroups,
	PDF_TAB_LABELS
} from "@/features/pdf/ribbon/pdfRibbon.logic"
import { togglePdfPagesRail, usePdfPagesRailOpen } from "@/features/pdf/pages/railOpen"
import type { PreviewKey } from "@/lib/i18n"
import { Kbd } from "@/lib/keymap/kbd"

// The PDF view's ribbon (the office ribbon): Home (the viewer's commands, then its tools), Fill & Sign, Pages, Protect
// and Tools, each tab's tools in their groups. Once the document has changes the tab row's end gains Undo, Redo, Save
// (with Save as copy) and Discard. Hovering or focusing a tool, or choosing Tools, starts fetching the editor.

export interface PdfRibbonHistory {
	readonly dirty: boolean
	readonly canUndo: boolean
	readonly canRedo: boolean
	readonly saving: boolean
	// false offline or while a save runs: Save and Save as copy are disabled
	readonly canSave: boolean
	undo(): void
	redo(): void
	save(): void
	saveAsCopy(): void
	// Opens the Protect document dialog (Security…), absent where it is not offered.
	security?: (() => void) | undefined
	discard(): void
	// The Save menu's "Flatten annotations" option (written into the pages on the next save), absent where none applies.
	readonly flatten?: { readonly on: boolean; readonly enabled: boolean; toggle(): void }
	// A new document of extracted pages, saved nowhere yet: Save makes it a file (there is no copy to save besides), and
	// Discard drops it.
	readonly draft?: boolean
}

export interface PdfRibbonProps extends PdfCommandBarProps {
	readonly tools: readonly PdfTool[]
	readonly policy: PdfPolicyState
	readonly toolContext: PdfToolContext
	readonly activeTool: string | null
	// The chosen variant of each tool with variants, by tool id.
	readonly toolVariants?: Readonly<Record<string, string>>
	readonly onActivateTool: (id: string | null, variant?: string) => void
	// A tool control was hovered or focused, or the Tools tab chosen: the host starts fetching the editor.
	readonly onPrefetch: () => void
	// Null until the editor holds the document.
	readonly history: PdfRibbonHistory | null
}

const TOOL_GROUP_PRIORITY = 4
// A tool's variant menu button: a 24 px target, 44 px under a finger.
const VARIANT_MENU = 24
const VARIANT_MENU_COARSE = 44

function PdfToolButton({ tool, props }: { tool: PdfTool; props: PdfRibbonProps }) {
	const { t } = useTranslation("preview")
	const control = pdfToolControl(tool, props.policy, props.activeTool)
	const action = tool.actionIds[0]
	const variant = toolVariant(tool, props.toolVariants?.[tool.id])
	const Icon = variant?.icon ?? tool.icon
	const button = (
		<TooltipIconButton
			label={variant === null ? t(tool.labelKey) : t(variant.labelKey)}
			disabled={control.reasonKey !== null}
			title={control.reasonKey === null ? undefined : t(control.reasonKey)}
			pressed={control.pressed}
			className={cn("shrink-0", control.pressed === true && "bg-accent text-foreground", variant !== null && "rounded-r-none")}
			shortcut={action === undefined ? null : <Kbd action={action} />}
			onMouseDown={keepFocus}
			onClick={() => {
				if (tool.run === undefined) {
					props.onActivateTool(nextActiveTool(tool, props.activeTool), variant?.id)
				} else {
					tool.run(props.toolContext)
				}
			}}
		>
			<Icon />
		</TooltipIconButton>
	)

	if (variant === null) return button

	// A tool with variants: the button uses the chosen one, the menu beside it picks another (and makes it active).
	return (
		<span className="flex shrink-0 items-center">
			{button}
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={control.reasonKey !== null}
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={t("previewPdfToolVariants", { tool: t(tool.labelKey) })}
							className="w-6 rounded-l-none pointer-coarse:w-11"
							onMouseDown={keepFocus}
						/>
					}
				>
					<ChevronDownIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent data-preview-surface>
					{(tool.variants ?? []).map(entry => (
						<DropdownMenuItem
							key={entry.id}
							onClick={() => {
								props.onActivateTool(tool.id, entry.id)
							}}
						>
							<entry.icon aria-hidden="true" />
							{t(entry.labelKey)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	)
}

function toolGroups(props: PdfRibbonProps, tab: PdfRibbonTab, label: (key: PreviewKey) => string, coarse: boolean): RibbonGroup[] {
	const groups: RibbonGroup[] = []
	const variantMenu = coarse ? VARIANT_MENU_COARSE : VARIANT_MENU

	for (const group of pdfToolGroups(props.tools, tab)) {
		const first = group.tools[0]
		const labelKey = pdfToolGroupLabelKey(group)

		if (first === undefined || labelKey === null) continue

		groups.push({
			id: `tool-${group.id}`,
			label: label(labelKey),
			icon: first.icon,
			width: group.tools.reduce((sum, tool) => sum + BAR_BUTTON + (tool.variants === undefined ? 0 : variantMenu), 0),
			priority: TOOL_GROUP_PRIORITY,
			single: group.tools.length === 1,
			content: (
				<span
					className="contents"
					onPointerEnter={props.onPrefetch}
					onFocus={props.onPrefetch}
				>
					{group.tools.map(tool => (
						<PdfToolButton
							key={tool.id}
							tool={tool}
							props={props}
						/>
					))}
				</span>
			)
		})
	}

	return groups
}

// The Pages tab's first control: the pages rail beside the pages, shown or hidden (kept on this device).
function PagesRailToggle() {
	const { t } = useTranslation("preview")
	const open = usePdfPagesRailOpen()

	return (
		<TooltipIconButton
			label={t("previewPdfPagesRailToggle")}
			pressed={open}
			className={cn("shrink-0", open && "bg-accent text-foreground")}
			onMouseDown={keepFocus}
			onClick={togglePdfPagesRail}
		>
			<PanelLeftIcon />
		</TooltipIconButton>
	)
}

function pagesRailGroup(label: string): RibbonGroup {
	return {
		id: "pages-rail",
		label,
		icon: PanelLeftIcon,
		width: BAR_BUTTON,
		priority: TOOL_GROUP_PRIORITY,
		single: true,
		content: <PagesRailToggle />
	}
}

function HistoryControls({ history, onDiscard }: { history: PdfRibbonHistory; onDiscard: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex shrink-0 items-center gap-1">
			<TooltipIconButton
				label={t("previewPdfUndo")}
				disabled={!history.canUndo || history.saving}
				shortcut={<Kbd action="pdf.undo" />}
				onMouseDown={keepFocus}
				onClick={() => {
					history.undo()
				}}
			>
				<Undo2Icon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewPdfRedo")}
				disabled={!history.canRedo || history.saving}
				shortcut={<Kbd action="pdf.redo" />}
				onMouseDown={keepFocus}
				onClick={() => {
					history.redo()
				}}
			>
				<Redo2Icon />
			</TooltipIconButton>
			<div className="flex items-center">
				<Button
					size="xs"
					disabled={!history.canSave}
					className="rounded-r-none"
					onClick={() => {
						history.save()
					}}
				>
					{history.saving ? <Spinner data-icon="inline-start" /> : null}
					{t("previewPdfSave")}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								size="icon-xs"
								disabled={!history.canSave}
								aria-label={t("previewPdfSaveOptions")}
								className="rounded-l-none border-l-primary-foreground/20"
							/>
						}
					>
						<ChevronDownIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						data-preview-surface
					>
						<DropdownMenuItem
							onClick={() => {
								history.save()
							}}
						>
							{t("previewPdfSave")}
							<MenuShortcut>
								<Kbd action="preview.save" />
							</MenuShortcut>
						</DropdownMenuItem>
						{history.draft === true ? null : (
							<DropdownMenuItem
								onClick={() => {
									history.saveAsCopy()
								}}
							>
								{t("previewPdfSaveAsCopy")}
							</DropdownMenuItem>
						)}
						{history.flatten === undefined ? null : (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuCheckboxItem
									checked={history.flatten.on}
									disabled={!history.flatten.enabled}
									title={t("previewPdfAnnotFlattenBody")}
									onCheckedChange={() => {
										history.flatten?.toggle()
									}}
								>
									{t("previewPdfAnnotFlatten")}
								</DropdownMenuCheckboxItem>
							</>
						)}
						{history.security === undefined ? null : (
							<DropdownMenuItem
								onClick={() => {
									history.security?.()
								}}
							>
								{t("previewPdfSecurityMenu")}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<Button
				variant="ghost"
				size="xs"
				// Nothing unsaved (a save keeps the history): nothing to discard.
				disabled={history.saving || !history.dirty}
				onClick={onDiscard}
			>
				{t("previewPdfDiscard")}
			</Button>
		</div>
	)
}

export function PdfRibbon(props: PdfRibbonProps) {
	const { t } = useTranslation(["preview", "common"])
	const parts = usePdfCommandParts(props)
	const [tab, setTab] = useState<PdfRibbonTab>("home")
	const [discarding, setDiscarding] = useState(false)
	const tabs: RibbonTab[] = PDF_RIBBON_TABS.map(id => ({ id, label: t(PDF_TAB_LABELS[id]) }))
	const coarse = useCoarsePointer()
	const tools = toolGroups(props, tab, key => t(key), coarse)
	const groups =
		tab === "home" ? [...parts.groups, ...tools] : tab === "pages" ? [pagesRailGroup(t("previewPdfPagesRailToggle")), ...tools] : tools
	const history = props.history

	// Nothing left to discard (a save ran meanwhile): the question goes, and never comes back on a later change.
	if (discarding && history?.dirty !== true) setDiscarding(false)

	return (
		<>
			<OfficeRibbon
				label={t("previewPdfRibbonLabel")}
				commandsLabel={t("previewPdfRibbonCommands")}
				tabs={tabs}
				tab={tab}
				onTab={value => {
					const next = pdfRibbonTab(value)

					if (next === null) return

					if (next === "tools") props.onPrefetch()

					setTab(next)
				}}
				file={parts.file}
				status={
					<>
						{parts.status}
						{history !== null && (history.dirty || history.canUndo || history.canRedo) ? (
							<HistoryControls
								history={history}
								onDiscard={() => {
									setDiscarding(true)
								}}
							/>
						) : null}
					</>
				}
				groups={groups}
				replacement={parts.replacement}
			/>
			<ConfirmDialog
				open={discarding && history?.dirty === true}
				pending={false}
				title={t(history?.draft === true ? "previewPdfDraftDiscardTitle" : "previewPdfDiscardTitle")}
				body={t(history?.draft === true ? "previewPdfDraftDiscardBody" : "previewPdfDiscardBody")}
				confirmLabel={t("previewPdfDiscardConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					setDiscarding(open)
				}}
				onConfirm={() => {
					setDiscarding(false)
					history?.discard()
				}}
			/>
		</>
	)
}
