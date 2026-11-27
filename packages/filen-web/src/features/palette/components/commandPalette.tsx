import { useId, useRef, useState, type ComponentType, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { useRouter } from "@tanstack/react-router"
import type { Options } from "react-hotkeys-hook"
import { cn } from "@filen/shared"
import { matchesCombo } from "@filen/shared/keymap"
import { FileIcon, FolderIcon, MessageSquareIcon, SearchIcon, SettingsIcon, StickyNoteIcon, ZapIcon } from "lucide-react"
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { SCRIM_CLASS } from "@/components/ui/surface"
import { ListFilterInput } from "@/components/listFilterInput"
import { Kbd } from "@/lib/keymap/kbd"
import { comboFor } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { ignoredUnderOverlays, useAction } from "@/lib/keymap/useAction"
import { useAssistantHidden } from "@/features/assistant/store/assistantHidden"
import { flattenSections, rankPalette, type PaletteGroup, type PaletteItem, type PaletteTarget } from "@/features/palette/lib/palette.logic"
import { buildPaletteIndex, PALETTE_ACTION_ID } from "@/features/palette/lib/paletteIndex"
import { paletteRecent, rememberPaletteRow, runPaletteTarget } from "@/features/palette/lib/paletteRun"

const IS_MAC = isMacPlatform()

// Mod+K opens it from the page and from a plain text field (the drive search box), never from under a dialog or menu,
// nor from editable text, where an editor's own link key holds it.
const PALETTE_KEY_OPTIONS: Options = { ignoreEventWhen: ignoredUnderOverlays, enableOnFormTags: ["option", "input"] }

const GROUP_LABEL_KEYS = {
	recent: "commandPaletteGroupRecent",
	actions: "commandPaletteGroupActions",
	navigation: "commandPaletteGroupNavigation",
	files: "commandPaletteGroupFiles",
	notes: "commandPaletteGroupNotes",
	chats: "commandPaletteGroupChats"
} as const satisfies Record<PaletteGroup, string>

type IconType = ComponentType<{ className?: string }>

function iconOf(target: PaletteTarget): IconType {
	switch (target.kind) {
		case "action":
			return ZapIcon
		case "settingsSection":
		case "setting":
			return SettingsIcon
		case "directory":
			return FolderIcon
		case "file":
			return FileIcon
		case "note":
			return StickyNoteIcon
		case "chat":
			return MessageSquareIcon
		case "driveSearch":
			return SearchIcon
	}
}

interface PaletteSession {
	// Where focus was when it opened: actions run there, and only those it can reach are offered.
	focus: Element | null
	items: PaletteItem[]
}

// The command palette for the signed-in app, mounted once in the shell. Its rows are built when it opens, from what the
// app already holds (paletteIndex.ts); a picked row runs once the dialog has closed, so an action meets the page as
// its key would.
export function CommandPaletteHost() {
	const { t } = useTranslation("common")
	const router = useRouter()
	const assistantHidden = useAssistantHidden()
	const [session, setSession] = useState<PaletteSession | null>(null)
	const [open, setOpen] = useState(false)
	const picked = useRef<PaletteTarget | null>(null)

	useAction(
		PALETTE_ACTION_ID,
		event => {
			event.preventDefault()

			const focus = document.activeElement

			picked.current = null
			setSession({ focus, items: buildPaletteIndex({ focus, assistantHidden }) })
			setOpen(true)
		},
		PALETTE_KEY_OPTIONS
	)

	function pick(item: PaletteItem): void {
		rememberPaletteRow(item.key)
		picked.current = item.target
		setOpen(false)
	}

	function onOpenChangeComplete(isOpen: boolean): void {
		if (isOpen) {
			return
		}

		const target = picked.current
		const focus = session?.focus ?? null

		picked.current = null
		setSession(null)

		if (target !== null) {
			runPaletteTarget(target, router, focus)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={onOpenChangeComplete}
		>
			{session === null ? null : (
				<DialogPrimitive.Portal>
					<DialogPrimitive.Backdrop
						forceRender
						className={SCRIM_CLASS}
					/>
					<DialogPrimitive.Popup className="fixed top-[12svh] left-1/2 z-50 flex max-h-[min(70svh,36rem)] w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2 rounded-[min(var(--radius-4xl),24px)] bg-popover p-3 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/5 duration-100 outline-none dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
						<DialogTitle className="sr-only">{t("commandPalette")}</DialogTitle>
						<DialogDescription className="sr-only">{t("commandPalettePlaceholder")}</DialogDescription>
						<PaletteBody
							items={session.items}
							onPick={pick}
							onClose={() => {
								setOpen(false)
							}}
						/>
					</DialogPrimitive.Popup>
				</DialogPrimitive.Portal>
			)}
		</Dialog>
	)
}

function optionId(listboxId: string, index: number): string {
	return `${listboxId}-option-${String(index)}`
}

interface PaletteBodyProps {
	items: readonly PaletteItem[]
	onPick: (item: PaletteItem) => void
	onClose: () => void
}

// The search box and the grouped list it drives through aria-activedescendant, as the settings search does. Mounted
// per opening, so every opening starts empty.
export function PaletteBody({ items, onPick, onClose }: PaletteBodyProps) {
	const { t } = useTranslation("common")
	const [query, setQuery] = useState("")
	const [activeIndex, setActiveIndex] = useState(0)
	const listboxId = useId()
	const sections = rankPalette(items, query, { recent: paletteRecent(), driveSearch: true })
	const rows = flattenSections(sections)
	const active = Math.min(activeIndex, rows.length - 1)

	function moveActive(index: number): void {
		setActiveIndex(index)
		document.getElementById(optionId(listboxId, index))?.scrollIntoView({ block: "nearest" })
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
		// Its own key closes it again.
		if (matchesCombo(event.nativeEvent, comboFor(PALETTE_ACTION_ID), IS_MAC)) {
			event.preventDefault()
			onClose()

			return
		}

		if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			onClose()

			return
		}

		const row = rows[active]

		if (row === undefined) {
			return
		}

		if (event.key === "ArrowDown") {
			event.preventDefault()
			moveActive((active + 1) % rows.length)
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			moveActive((active - 1 + rows.length) % rows.length)
		} else if (event.key === "Home" && event.ctrlKey) {
			event.preventDefault()
			moveActive(0)
		} else if (event.key === "End" && event.ctrlKey) {
			event.preventDefault()
			moveActive(rows.length - 1)
		} else if (event.key === "Enter") {
			event.preventDefault()
			onPick(row)
		}
	}

	// Each section's first row in the flat list.
	const starts: number[] = []
	let start = 0

	for (const section of sections) {
		starts.push(start)
		start += section.items.length
	}

	return (
		<>
			<ListFilterInput
				value={query}
				onChange={value => {
					setQuery(value)
					setActiveIndex(0)
				}}
				placeholder={t("commandPalettePlaceholder")}
				ariaLabel={t("commandPalettePlaceholder")}
				onKeyDown={onKeyDown}
				combobox={{
					listboxId,
					expanded: rows.length > 0,
					activeDescendant: active >= 0 ? optionId(listboxId, active) : undefined
				}}
			/>
			{rows.length === 0 ? (
				<p
					role="status"
					className="px-2.5 py-2 text-sm text-muted-foreground"
				>
					{t("commandPaletteNoResults")}
				</p>
			) : (
				<div
					id={listboxId}
					role="listbox"
					aria-label={t("commandPaletteResults")}
					className="flex min-h-0 flex-col gap-2 overflow-y-auto"
				>
					{sections.map((section, sectionIndex) => {
						const first = starts[sectionIndex] ?? 0
						const headingId = `${listboxId}-${section.group}`

						return (
							<div
								key={section.group}
								role="group"
								aria-labelledby={headingId}
								className="flex flex-col gap-0.5"
							>
								<div
									id={headingId}
									role="presentation"
									className="px-2.5 pt-1 text-xs font-medium text-muted-foreground"
								>
									{t(GROUP_LABEL_KEYS[section.group])}
								</div>
								{section.items.map((item, itemIndex) => {
									const rowIndex = first + itemIndex
									const Icon = iconOf(item.target)
									const title =
										item.target.kind === "driveSearch"
											? t("commandPaletteSearchDrive", { query: item.target.query })
											: item.title

									return (
										<div
											key={item.key}
											id={optionId(listboxId, rowIndex)}
											role="option"
											aria-selected={rowIndex === active}
											className={cn(
												"flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left hover:bg-accent/60",
												rowIndex === active && "bg-accent text-accent-foreground"
											)}
											// The box keeps focus; a row's mousedown leaves it there.
											onMouseDown={event => {
												event.preventDefault()
											}}
											onClick={() => {
												onPick(item)
											}}
										>
											<Icon className="size-4 shrink-0 text-muted-foreground" />
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="truncate">{title}</span>
												{item.detail === undefined ? null : (
													<span className="truncate text-xs text-muted-foreground">{item.detail}</span>
												)}
											</span>
											{item.actionId === undefined ? null : <Kbd action={item.actionId} />}
										</div>
									)
								})}
							</div>
						)
					})}
				</div>
			)}
		</>
	)
}
