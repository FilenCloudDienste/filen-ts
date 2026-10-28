import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { Tabs } from "@base-ui/react/tabs"
import { ChevronDownIcon, ChevronUpIcon, MoreHorizontalIcon, type LucideIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SuspendDragRegions } from "@/components/ui/suspendDragRegions"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { keepFocus } from "@/features/office/lib/officeControls"
import { setRibbonCollapsed, useRibbonCollapsed } from "@/features/office/lib/ribbonSettings"
import { ribbonFit, type RibbonGroupState } from "@/features/office/components/ribbon/ribbonFit"
import { RibbonToolbar } from "@/features/office/components/ribbon/ribbonToolbar"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { KbdKeys } from "@/lib/keymap/kbd"
import { useElementSize } from "@/lib/useElementSize"

// The office editors' ribbon, as Office for the web's simplified (single-line) ribbon: a row of tabs (the File menu
// first, contextual tabs after the rest while their object is selected, status badges and the collapse switch at the
// end) over one row of the selected tab's command groups. Groups the row has no room for collapse into a dropdown
// each, then move into its overflow menu (ribbonFit). "Show tabs only" (the chevron, Ctrl+F1) hides the command row
// until a tab is clicked. Only the selected tab's groups are rendered.
//
// The document viewers' command bar (OfficeCommandBar) is that command row on its own, with no tab row: the File menu
// first, then the groups, then the status.

export interface RibbonTab {
	readonly id: string
	readonly label: string
	// Shown while its object is selected (Table, Picture, Chart), in the accent colour.
	readonly contextual?: boolean
}

export interface RibbonGroup {
	readonly id: string
	readonly label: string
	// The collapsed group's button.
	readonly icon: LucideIcon
	// px in full (its controls, not its divider).
	readonly width: number
	// Higher stays longer in the row; Infinity never leaves it.
	readonly priority: number
	// One control already: never collapses into a dropdown of its own.
	readonly single?: boolean
	readonly content: ReactNode
}

export interface OfficeRibbonProps {
	// The tab list's name.
	label: string
	// The command row's name.
	commandsLabel: string
	tabs: readonly RibbonTab[]
	tab: string
	onTab: (tab: string) => void
	// The File menu, first in the tab row.
	file: ReactNode
	// Badges and the zoom, at the tab row's end.
	status?: ReactNode
	groups: readonly RibbonGroup[]
	// Shown in place of the groups (the find field).
	replacement?: ReactNode
}

const DIVIDER_WIDTH = 11
const COLLAPSED_WIDTH = 44
// The command row's padding.
const ROW_PADDING = 16

function Divider() {
	return (
		<span
			aria-hidden="true"
			className="mx-1 h-5 w-px shrink-0 bg-border"
		/>
	)
}

function activeElement(): HTMLElement | null {
	return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

// Whether a click in a popup of the ribbon ran a command (it closes the popup, as Office's do): a button or item
// that opens nothing further.
function ranCommand(event: MouseEvent): boolean {
	const target = event.target instanceof Element ? event.target.closest('button, [role^="menuitem"], [role="option"]') : null

	return target !== null && !target.hasAttribute("aria-haspopup") && target.getAttribute("aria-expanded") === null
}

// A popup of the ribbon (a collapsed group, the overflow, the peeked command row): closed by a command run in it,
// which leaves focus where the command put it (the document), else where it was before the popup opened.
function useRibbonPopup(): {
	open: boolean
	setOpen: (open: boolean) => void
	onClick: (event: MouseEvent) => void
	finalFocus: () => HTMLElement | boolean
} {
	const [open, setOpenState] = useState(false)
	const beforeRef = useRef<HTMLElement | null>(null)
	const ranRef = useRef(false)

	return {
		open,
		setOpen: next => {
			if (next) {
				beforeRef.current = activeElement()
				ranRef.current = false
			}

			setOpenState(next)
		},
		onClick: event => {
			if (ranCommand(event)) {
				ranRef.current = true

				const focused = activeElement()

				// Back to the document in the same click, not after the popup's close transition: keys typed straight
				// after the command would land in the closing popup. A command that moved focus on keeps it there.
				if (
					(focused === null || focused === document.body || focused.closest("[data-ribbon-popup]") !== null) &&
					beforeRef.current?.isConnected === true
				) {
					beforeRef.current.focus({ preventScroll: true })
				}

				setOpenState(false)
			}
		},
		finalFocus: () => {
			if (!ranRef.current) {
				return true
			}

			ranRef.current = false

			const focused = activeElement()

			// The command moved focus on (the document): it stays there.
			if (focused !== null && focused !== document.body && focused.closest("[data-ribbon-popup]") === null) {
				return false
			}

			return beforeRef.current?.isConnected === true ? beforeRef.current : true
		}
	}
}

// A group with no room for its controls: one button opening them.
function CollapsedGroup({ group }: { group: RibbonGroup }) {
	const popup = useRibbonPopup()
	const Icon = group.icon

	return (
		<Popover
			open={popup.open}
			onOpenChange={popup.setOpen}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="sm"
									aria-label={group.label}
									data-ribbon-group={group.id}
									className="shrink-0 gap-0.5 px-1.5"
									onMouseDown={keepFocus}
								>
									<Icon />
									<ChevronDownIcon className="size-3" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{group.label}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				data-preview-surface
				data-ribbon-popup
				className="w-auto max-w-[min(36rem,calc(100vw-2rem))] gap-1 rounded-2xl p-1.5"
				finalFocus={popup.finalFocus}
				onClick={popup.onClick}
			>
				<RibbonToolbar
					label={group.label}
					className="flex-wrap"
				>
					{group.content}
				</RibbonToolbar>
			</PopoverContent>
		</Popover>
	)
}

// The groups the row has no room for, each under its name.
function Overflow({ groups }: { groups: readonly RibbonGroup[] }) {
	const { t } = useTranslation("preview")
	const popup = useRibbonPopup()

	return (
		<Popover
			open={popup.open}
			onOpenChange={popup.setOpen}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("previewOfficeRibbonMore")}
									className="shrink-0"
									onMouseDown={keepFocus}
								>
									<MoreHorizontalIcon />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("previewOfficeRibbonMore")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="end"
				data-preview-surface
				data-ribbon-popup
				className="max-h-[min(32rem,var(--available-height))] w-auto max-w-[min(36rem,calc(100vw-2rem))] gap-2 overflow-y-auto rounded-2xl p-2"
				finalFocus={popup.finalFocus}
				onClick={popup.onClick}
			>
				{groups.map(group => (
					<section
						key={group.id}
						className="flex flex-col gap-1"
					>
						<p className="px-1 text-xs font-medium text-muted-foreground">{group.label}</p>
						<RibbonToolbar
							label={group.label}
							className="flex-wrap"
						>
							{group.content}
						</RibbonToolbar>
					</section>
				))}
			</PopoverContent>
		</Popover>
	)
}

export function CommandRow({
	commandsLabel,
	groups,
	replacement,
	phone,
	className
}: {
	commandsLabel: string
	groups: readonly RibbonGroup[]
	replacement: ReactNode
	// usePhoneWidth: groups skip collapsing.
	phone: boolean
	className?: string | undefined
}) {
	const [row, setRow] = useState<HTMLDivElement | null>(null)
	const { width } = useElementSize(row)
	const states = ribbonFit(
		width - ROW_PADDING,
		groups.map((group, index) => ({
			id: group.id,
			width: group.width + (index > 0 ? DIVIDER_WIDTH : 0),
			collapsedWidth: group.single === true ? null : COLLAPSED_WIDTH + (index > 0 ? DIVIDER_WIDTH : 0),
			priority: group.priority
		})),
		!phone
	)
	const state = (group: RibbonGroup): RibbonGroupState => states.get(group.id) ?? "full"
	const shown = groups.filter(group => state(group) !== "overflow")
	const overflowed = groups.filter(group => state(group) === "overflow")

	return (
		<div
			ref={setRow}
			className={cn("flex h-10 min-w-0 items-center px-2", className)}
		>
			{replacement ?? (
				<RibbonToolbar
					label={commandsLabel}
					className="min-w-0 flex-1 overflow-hidden"
				>
					{shown.map((group, index) => (
						<div
							key={group.id}
							className="contents"
						>
							{index > 0 ? <Divider /> : null}
							{state(group) === "collapsed" ? (
								<CollapsedGroup group={group} />
							) : (
								<div
									role="group"
									aria-label={group.label}
									data-ribbon-group={group.id}
									className="flex shrink-0 items-center gap-0.5"
								>
									{group.content}
								</div>
							)}
						</div>
					))}
					{overflowed.length > 0 ? (
						<>
							<div className="min-w-0 flex-1" />
							<Overflow groups={overflowed} />
						</>
					) : null}
				</RibbonToolbar>
			)}
		</div>
	)
}

export function OfficeRibbon(props: OfficeRibbonProps) {
	const { t } = useTranslation("preview")
	const collapsed = useRibbonCollapsed()
	const phone = usePhoneWidth()
	const [tabRow, setTabRow] = useState<HTMLDivElement | null>(null)
	// Show tabs only: the command row a clicked tab shows over the content until a command runs or focus leaves.
	const peek = useRibbonPopup()
	const peeking = collapsed && peek.open
	const setPeek = peek.setOpen
	// A tab chosen from the keyboard takes focus into the row it shows.
	const [peekFocus, setPeekFocus] = useState(false)

	// Ctrl+F1 anywhere in the editor shows or hides the command row, as in Office.
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "F1" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
				event.preventDefault()
				setPeek(false)
				setRibbonCollapsed(!collapsed)
			}
		}

		window.addEventListener("keydown", onKey)

		return () => {
			window.removeEventListener("keydown", onKey)
		}
	}, [collapsed, setPeek])

	const row = (
		<Tabs.Panel
			value={props.tab}
			tabIndex={-1}
		>
			<CommandRow
				commandsLabel={props.commandsLabel}
				groups={props.groups}
				replacement={props.replacement}
				phone={phone}
			/>
		</Tabs.Panel>
	)

	return (
		<Tabs.Root
			value={props.tab}
			onValueChange={(value: string) => {
				props.onTab(value)
			}}
			data-office-ribbon
			className="shrink-0 border-b border-border"
		>
			<div
				ref={setTabRow}
				className={cn("flex h-9 items-center gap-1 px-2", !collapsed && "border-b border-border/60")}
			>
				{props.file}
				<Tabs.List
					aria-label={props.label}
					className="-mb-px flex min-w-0 [scrollbar-width:none] items-stretch self-stretch overflow-x-auto [&::-webkit-scrollbar]:hidden"
				>
					{props.tabs.map(tab => (
						<Tabs.Tab
							key={tab.id}
							value={tab.id}
							className={cn(
								"shrink-0 border-b-2 border-transparent px-2.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/30 aria-selected:border-primary aria-selected:font-medium aria-selected:text-foreground",
								tab.contextual === true && "text-primary aria-selected:text-primary"
							)}
							onClick={event => {
								if (collapsed) {
									setPeekFocus(event.detail === 0)
									setPeek(!(peek.open && tab.id === props.tab))
								}
							}}
						>
							{tab.label}
						</Tabs.Tab>
					))}
				</Tabs.List>
				<div className="min-w-2 flex-1" />
				{props.status}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={collapsed ? t("previewOfficeRibbonExpand") : t("previewOfficeRibbonCollapse")}
								aria-pressed={collapsed}
								className="shrink-0"
								onMouseDown={keepFocus}
								onClick={() => {
									setPeek(false)
									setRibbonCollapsed(!collapsed)
								}}
							>
								{collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
							</Button>
						}
					/>
					<TooltipContent>
						{collapsed ? t("previewOfficeRibbonExpand") : t("previewOfficeRibbonCollapse")}
						<KbdKeys keys={["Ctrl", "F1"]} />
					</TooltipContent>
				</Tooltip>
			</div>
			{collapsed ? (
				<PopoverPrimitive.Root
					open={peeking}
					onOpenChange={setPeek}
				>
					<PopoverPrimitive.Portal>
						<SuspendDragRegions />
						<PopoverPrimitive.Positioner
							anchor={tabRow}
							side="bottom"
							align="start"
							sideOffset={0}
							className="isolate z-40 w-(--anchor-width)"
						>
							<PopoverPrimitive.Popup
								data-preview-surface
								data-ribbon-popup
								initialFocus={peekFocus}
								finalFocus={peek.finalFocus}
								className="border-b border-border bg-background shadow-md outline-none"
								onClick={peek.onClick}
							>
								{row}
							</PopoverPrimitive.Popup>
						</PopoverPrimitive.Positioner>
					</PopoverPrimitive.Portal>
				</PopoverPrimitive.Root>
			) : (
				row
			)}
		</Tabs.Root>
	)
}

export interface OfficeCommandBarProps {
	// The command row's name.
	label: string
	// The File menu, first in the row.
	file?: ReactNode
	groups: readonly RibbonGroup[]
	// At the row's end; what a phone has no room for carries max-sm:hidden.
	status?: ReactNode
	// Shown in place of the groups (the find field).
	replacement?: ReactNode
}

// One row: the File menu, the groups (fitted as the ribbon's command row), the status. No tabs, so no Show tabs only.
export function OfficeCommandBar({ label, file, groups, status, replacement }: OfficeCommandBarProps) {
	const phone = usePhoneWidth()

	return (
		<div
			data-office-ribbon
			className="flex h-10 shrink-0 items-center border-b border-border"
		>
			{file === undefined || file === null ? null : <div className="flex shrink-0 items-center pl-2">{file}</div>}
			<CommandRow
				commandsLabel={label}
				groups={groups}
				replacement={replacement}
				phone={phone}
				className="flex-1"
			/>
			{status === undefined || status === null ? null : <div className="flex shrink-0 items-center gap-1 pr-2">{status}</div>}
		</div>
	)
}
