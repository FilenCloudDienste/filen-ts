import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent,
	type ReactNode
} from "react"
import { createPortal } from "react-dom"
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
import {
	FILE_KEYTIP,
	controlKeyTips,
	createKeyTipTrigger,
	keyTipCharacters,
	matchKeyTip,
	tabKeyTips
} from "@/features/office/components/ribbon/ribbonKeyTips"
import { desktopPlatform } from "@/lib/desktop"
import { KbdKeys } from "@/lib/keymap/kbd"
import { useElementSize } from "@/lib/useElementSize"

// The office editors' ribbon, as Office for the web's simplified (single-line) ribbon: a row of tabs (the File menu
// first, contextual tabs after the rest while their object is selected, status badges and the collapse switch at the
// end) over one row of the selected tab's command groups. Groups the row has no room for collapse into a dropdown
// each, then move into its overflow menu (ribbonFit). "Show tabs only" (the chevron, Ctrl+F1) hides the command row
// until a tab is clicked. Only the selected tab's groups are rendered. KeyTips (RibbonKeyTips) drive it from the keyboard.
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
	onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => void
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
		// One Escape on a command in the popup closes it (focus back on its trigger, finalFocus), ahead of the command's
		// tooltip, which would take the key and keep the popup. A menu or list opened from a command (they render
		// outside the popup) or an expanded control answers its own Escape.
		onKeyDownCapture: event => {
			const target = event.target

			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				!(target instanceof Element) ||
				!event.currentTarget.contains(target) ||
				target.getAttribute("aria-expanded") === "true"
			) {
				return
			}

			event.preventDefault()
			setOpenState(false)
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
									data-ribbon-popup-trigger={group.id}
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
				onKeyDownCapture={popup.onKeyDownCapture}
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
									data-ribbon-popup-trigger="more"
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
				aria-label={t("previewOfficeRibbonMore")}
				className="max-h-[min(32rem,var(--available-height))] w-auto max-w-[min(36rem,calc(100vw-2rem))] gap-2 overflow-y-auto rounded-2xl p-2"
				finalFocus={popup.finalFocus}
				onClick={popup.onClick}
				onKeyDownCapture={popup.onKeyDownCapture}
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
			// A replacement (the find bar) may wrap on a phone: the row grows with it rather than clipping its second line.
			className={cn("flex min-h-10 min-w-0 items-center px-2", replacement != null && "py-1", className)}
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

interface KeyTipBadge {
	readonly tip: string
	readonly element: HTMLElement
	readonly x: number
	readonly y: number
}

interface KeyTipLayer {
	readonly level: "tabs" | "commands"
	readonly typed: string
	// Measured once the level's targets are on screen.
	readonly badges: readonly KeyTipBadge[] | null
}

// A command's target in the row: a group's controls, a collapsed group's button and the overflow's.
const KEYTIP_CONTROL =
	'button, input, select, textarea, [role="button"], [role="combobox"], [role="checkbox"], [role="switch"], [role="radio"]'
const KEYTIP_FIELD = 'input, select, textarea, [role="combobox"]'

function keyTipTargetShown(element: HTMLElement): DOMRect | null {
	if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return null

	const rect = element.getBoundingClientRect()

	return rect.width > 0 && rect.height > 0 ? rect : null
}

function tabBadges(root: HTMLElement, tabs: readonly RibbonTab[]): KeyTipBadge[] {
	const tips = tabKeyTips(tabs)
	const badges: KeyTipBadge[] = []
	const add = (element: HTMLElement | null, tip: string): void => {
		const rect = element === null ? null : keyTipTargetShown(element)

		if (element !== null && rect !== null) badges.push({ tip, element, x: rect.left + rect.width / 2, y: rect.bottom })
	}

	add(root.querySelector<HTMLElement>("[data-ribbon-file]"), FILE_KEYTIP)

	for (const element of root.querySelectorAll<HTMLElement>("[data-ribbon-tab]")) {
		const index = tabs.findIndex(tab => tab.id === element.dataset["ribbonTab"])
		const tip = tips[index]

		if (tip !== undefined) add(element, tip)
	}

	return badges
}

function commandBadges(panel: HTMLElement): KeyTipBadge[] {
	const targets: HTMLElement[] = []
	const rects: DOMRect[] = []
	const seen = new Set<Element>()

	for (const element of panel.querySelectorAll<HTMLElement>(
		`[data-ribbon-popup-trigger], [role="group"][data-ribbon-group] :is(${KEYTIP_CONTROL})`
	)) {
		seen.add(element)

		// A control inside another (a combobox's button) is the outer one's.
		let parent = element.parentElement
		let nested = false

		while (parent !== null && parent !== panel && !nested) {
			nested = seen.has(parent)
			parent = parent.parentElement
		}

		const rect = nested ? null : keyTipTargetShown(element)

		if (rect !== null) {
			targets.push(element)
			rects.push(rect)
		}
	}

	const tips = controlKeyTips(targets.map(element => element.getAttribute("aria-label") ?? element.textContent))
	const badges: KeyTipBadge[] = []

	targets.forEach((element, index) => {
		const rect = rects[index]
		const tip = tips[index]

		if (rect !== undefined && tip !== undefined) badges.push({ tip, element, x: rect.left + rect.width / 2, y: rect.bottom })
	})

	return badges
}

// KeyTips (Alt+Windows / Alt+Command, and on the Windows and Linux desktop shell a bare Alt or F10, as in Office): badges
// on the File menu and the tabs, then, once a tab is picked, on its commands; typing a tip picks its target. Escape goes
// back a level; a click, another key or the trigger again hides them. Idle, it is two key listeners and renders nothing.
function RibbonKeyTips({
	root,
	panel,
	tabs,
	onTab,
	onBack
}: {
	root: HTMLElement | null
	panel: HTMLElement | null
	tabs: readonly RibbonTab[]
	onTab: (tab: string) => void
	onBack: () => void
}) {
	const [layer, setLayer] = useState<KeyTipLayer | null>(null)
	const [trigger] = useState(() => {
		const platform = desktopPlatform()

		return createKeyTipTrigger(platform !== undefined && platform !== "darwin" ? "alt" : "chord")
	})
	const active = layer !== null

	const pick = (badge: KeyTipBadge, level: KeyTipLayer["level"]): void => {
		if (level === "tabs" && badge.element.dataset["ribbonTab"] !== undefined) {
			onTab(badge.element.dataset["ribbonTab"])
			setLayer({ level: "commands", typed: "", badges: null })

			return
		}

		setLayer(null)

		if (badge.element.matches(KEYTIP_FIELD) && badge.element.tagName !== "BUTTON") {
			badge.element.focus()
		} else {
			badge.element.click()
		}
	}

	const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
		const fired = trigger.keydown(event)

		if (fired) {
			if (layer !== null || keyTipsAllowed(root, event.target)) {
				event.preventDefault()
				setLayer(layer === null ? { level: "tabs", typed: "", badges: null } : null)
			}

			return
		}

		if (layer === null || event.isComposing || MODIFIERS.has(event.key)) return

		if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault()
			event.stopImmediatePropagation()

			if (layer.typed !== "") {
				setLayer({ ...layer, typed: "" })
			} else if (layer.level === "commands") {
				onBack()
				setLayer({ level: "tabs", typed: "", badges: null })
			} else {
				setLayer(null)
			}

			return
		}

		const characters = event.ctrlKey || event.metaKey || event.altKey ? [] : keyTipCharacters(event)

		if (characters.length === 0) {
			// Any other key (an arrow, Tab, a shortcut) hides them and does what it does.
			setLayer(null)

			return
		}

		event.preventDefault()
		event.stopImmediatePropagation()

		if (layer.badges === null) return

		const tips = layer.badges.map(badge => badge.tip)

		for (const character of characters) {
			const match = matchKeyTip(tips, layer.typed + character)

			if (match === "prefix") {
				setLayer({ ...layer, typed: layer.typed + character })

				return
			}

			const badge = match === null ? undefined : layer.badges[match]

			if (badge !== undefined) {
				pick(badge, layer.level)

				return
			}
		}
	})

	const onKeyUp = useEffectEvent((event: KeyboardEvent): void => {
		if (!trigger.keyup(event) || (layer === null && !keyTipsAllowed(root, event.target))) return

		event.preventDefault()
		setLayer(layer === null ? { level: "tabs", typed: "", badges: null } : null)
	})

	useEffect(() => {
		const down = (event: KeyboardEvent): void => {
			onKeyDown(event)
		}
		const up = (event: KeyboardEvent): void => {
			onKeyUp(event)
		}
		const reset = (): void => {
			trigger.reset()
		}

		window.addEventListener("keydown", down, true)
		window.addEventListener("keyup", up, true)
		window.addEventListener("pointerdown", reset, true)

		return () => {
			window.removeEventListener("keydown", down, true)
			window.removeEventListener("keyup", up, true)
			window.removeEventListener("pointerdown", reset, true)
		}
	}, [trigger])

	// A click anywhere, the window losing focus or resizing hides them.
	useEffect(() => {
		if (!active) return undefined

		const dismiss = (): void => {
			setLayer(null)
		}

		window.addEventListener("pointerdown", dismiss, true)
		window.addEventListener("blur", dismiss)
		window.addEventListener("resize", dismiss)

		return () => {
			window.removeEventListener("pointerdown", dismiss, true)
			window.removeEventListener("blur", dismiss)
			window.removeEventListener("resize", dismiss)
		}
	}, [active])

	// The level's targets are measured once they are laid out (the picked tab's row rendered, a collapsed ribbon's shown).
	const level = layer?.level
	const measured = layer?.badges != null

	useEffect(() => {
		if (level === undefined || measured || root === null || (level === "commands" && panel === null)) return undefined

		const frame = requestAnimationFrame(() => {
			const badges = level === "tabs" || panel === null ? tabBadges(root, tabs) : commandBadges(panel)

			setLayer(previous => (previous?.level === level && previous.badges === null ? { ...previous, badges } : previous))
		})

		return () => {
			cancelAnimationFrame(frame)
		}
	}, [level, measured, root, panel, tabs])

	if (layer?.badges == null) return null

	return createPortal(
		<div
			aria-hidden="true"
			data-ribbon-keytips={layer.level}
			className="pointer-events-none fixed inset-0 z-50"
		>
			{layer.badges
				.filter(badge => badge.tip.startsWith(layer.typed))
				.map(badge => (
					<span
						key={badge.tip}
						data-ribbon-keytip={badge.tip}
						className="absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-popover px-1 text-[11px] leading-4 font-medium text-popover-foreground shadow-sm"
						style={{ left: badge.x, top: badge.y }}
					>
						{badge.tip}
					</span>
				))}
		</div>,
		document.body
	)
}

const MODIFIERS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "OS", "CapsLock"])

// The layer opens over the ribbon's own layer only: not from a dialog over it, nor while the ribbon is hidden or inert.
function keyTipsAllowed(root: HTMLElement | null, target: EventTarget | null): boolean {
	if (root === null || !root.isConnected || root.closest("[inert]") !== null) return false

	const dialog = target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"]') : null

	return dialog === null || dialog.contains(root)
}

export function OfficeRibbon(props: OfficeRibbonProps) {
	const { t } = useTranslation("preview")
	const collapsed = useRibbonCollapsed()
	const phone = usePhoneWidth()
	const [tabRow, setTabRow] = useState<HTMLDivElement | null>(null)
	const [root, setRoot] = useState<HTMLDivElement | null>(null)
	const [panel, setPanel] = useState<HTMLDivElement | null>(null)
	// Show tabs only: the command row a clicked tab shows over the content until a command runs or focus leaves.
	const peek = useRibbonPopup()
	const peeking = collapsed && peek.open
	const setPeek = peek.setOpen
	// A tab chosen from the keyboard takes focus into the row it shows.
	const [peekFocus, setPeekFocus] = useState(false)
	// The tab list scrolls when a narrow screen has no room for every tab; the clipped sides fade out as the cue.
	const [tabList, setTabList] = useState<HTMLDivElement | null>(null)
	const [overflow, setOverflow] = useState({ start: false, end: false })
	const measureTabs = (list: HTMLElement): void => {
		const start = list.scrollLeft > 1
		const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1

		setOverflow(previous => (previous.start === start && previous.end === end ? previous : { start, end }))
	}

	// Measured when the list resizes (its first observation included) and when its tabs change (a contextual tab).
	useEffect(() => {
		if (tabList === null) return undefined

		const measure = (): void => {
			measureTabs(tabList)
		}
		const resized = new ResizeObserver(measure)
		const changed = new MutationObserver(measure)

		resized.observe(tabList)
		changed.observe(tabList, { childList: true, subtree: true, characterData: true })

		return () => {
			resized.disconnect()
			changed.disconnect()
		}
	}, [tabList])

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
			ref={setPanel}
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
			ref={setRoot}
			data-office-ribbon
			className="shrink-0 border-b border-border"
		>
			<RibbonKeyTips
				root={root}
				panel={panel}
				tabs={props.tabs}
				onTab={tab => {
					if (tab !== props.tab) props.onTab(tab)

					// Show tabs only: the picked tab's row shows, focus staying in the document until a command runs.
					if (collapsed) {
						setPeekFocus(false)
						setPeek(true)
					}
				}}
				onBack={() => {
					setPeek(false)
				}}
			/>
			<div
				ref={setTabRow}
				className={cn("flex h-9 items-center gap-1 px-2", !collapsed && "border-b border-border/60")}
			>
				{props.file}
				<Tabs.List
					ref={setTabList}
					aria-label={props.label}
					data-overflow-start={overflow.start ? "" : undefined}
					data-overflow-end={overflow.end ? "" : undefined}
					className={cn(
						"-mb-px flex min-w-0 [scrollbar-width:none] items-stretch self-stretch overflow-x-auto [&::-webkit-scrollbar]:hidden",
						overflow.start && overflow.end
							? "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]"
							: overflow.start
								? "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]"
								: overflow.end
									? "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
									: undefined
					)}
					onScroll={event => {
						measureTabs(event.currentTarget)
					}}
				>
					{props.tabs.map(tab => (
						<Tabs.Tab
							key={tab.id}
							value={tab.id}
							data-ribbon-tab={tab.id}
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
