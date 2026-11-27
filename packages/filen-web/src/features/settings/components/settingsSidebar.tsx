import { useId, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import type { AppHelpEntry } from "@filen/shared/assistant"
import { Link, useRouter } from "@tanstack/react-router"
import { SidebarPanel } from "@/features/shell/components/sidebarPanel"
import { SIDEBAR_NAV_ITEM_CLASS } from "@/features/shell/lib/sidebarNavItem"
import { useMasterKeysNotExported } from "@/queries/account"
import { RailStatusDot } from "@/features/shell/components/railProgressBar"
import { ignoredUnderOverlays, OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { steppedItem } from "@/features/settings/lib/stepped.logic"
import { pageSearchClaimed, searchSettings } from "@/features/settings/lib/settingsSearch"
import { ListFilterInput } from "@/components/listFilterInput"
import { APP_HELP_SECTION_LABELS } from "@/lib/appHelp"
import { requestSettingsHighlight } from "@/lib/settingsHighlight"
import { SETTINGS_ITEMS, settingsSectionOf, type SettingsRoute } from "@/features/settings/lib/settingsSections"

const SETTINGS_ROUTES: readonly SettingsRoute[] = SETTINGS_ITEMS.map(item => item.to)

// The section `step` places from the one at `pathname` in sidebar order (steppedItem).
function steppedSettingsRoute(pathname: string, step: 1 | -1): SettingsRoute | null {
	const current = SETTINGS_ROUTES.find(route => pathname === route || pathname.startsWith(`${route}/`)) ?? null

	return steppedItem(SETTINGS_ROUTES, current, step)
}

// The id of a search result's row, which the search box names as its active descendant.
function resultOptionId(listboxId: string, index: number): string {
	return `${listboxId}-option-${String(index)}`
}

const RESULT_CLASS =
	"flex w-full cursor-pointer flex-col items-start rounded-xl px-2.5 py-1.5 text-left text-sm text-sidebar-foreground/80 transition-colors app-region-no-drag hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"

// The shell's settings contextual sidebar: a flat list of section nav links, same w-52
// rounded-xl borderless panel geometry as the other three module sidebars. TanStack stamps
// `data-status="active"` on the matching Link automatically — no manual pathname comparison needed
// (unlike DriveSidebar's splat routes, every settings route here takes no params). Above the list, a search over the
// settings the pages show; while it holds words, the matching settings stand in for the list.
export function SettingsSidebar() {
	const { t, i18n } = useTranslation(["settings", "common"])
	// A selector over the held account: no request, and a re-render only when the answer flips.
	const keysNotExported = useMasterKeysNotExported()
	const router = useRouter()
	const [query, setQuery] = useState("")
	const [activeIndex, setActiveIndex] = useState(0)
	const searchRef = useRef<HTMLInputElement>(null)
	const listboxId = useId()
	const searching = query.trim().length > 0
	const results = searching ? searchSettings(query, i18n.language) : []
	const active = Math.min(activeIndex, results.length - 1)

	// The location is read at the key press, not subscribed: nothing here renders it.
	function step(direction: 1 | -1): void {
		const to = steppedSettingsRoute(router.state.location.pathname, direction)

		if (to !== null) {
			void router.navigate({ to })
		}
	}

	// Defs in features/settings/lib/keymap.ts. Alt+↑/↓ walk the sections below; the page under a dialog or menu keeps
	// its place. Not in a text field, whose Alt+↑/↓ move the caret.
	useAction(
		"settings.previousSection",
		event => {
			event.preventDefault()
			step(-1)
		},
		OUTSIDE_OVERLAYS
	)

	useAction(
		"settings.nextSection",
		event => {
			event.preventDefault()
			step(1)
		},
		OUTSIDE_OVERLAYS
	)

	// Mod+F focuses the search, in place of the browser's find, from anywhere in Settings but another text field; a page
	// with a search of its own (Events, Keyboard) keeps the key for that.
	useAction(
		"settings.search",
		event => {
			event.preventDefault()
			searchRef.current?.focus()
			searchRef.current?.select()
		},
		{
			ignoreEventWhen: event =>
				ignoredUnderOverlays(event) ||
				pageSearchClaimed() ||
				(event.target instanceof HTMLInputElement && event.target !== searchRef.current),
			enableOnFormTags: ["option", "input"]
		}
	)

	function changeQuery(value: string): void {
		setQuery(value)
		setActiveIndex(0)
	}

	// Opens the page showing the setting, which scrolls to its row and rings it (useHelpHighlight).
	function openResult(entry: AppHelpEntry): void {
		const item = settingsSectionOf(entry)

		if (item === undefined) {
			return
		}

		requestSettingsHighlight(entry.id)
		void router.navigate({ to: item.to })
	}

	function moveActive(index: number): void {
		setActiveIndex(index)
		document.getElementById(resultOptionId(listboxId, index))?.scrollIntoView({ block: "nearest" })
	}

	function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
		const entry = results[active]

		if (entry === undefined) {
			return
		}

		if (event.key === "ArrowDown") {
			event.preventDefault()
			moveActive((active + 1) % results.length)
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			moveActive((active - 1 + results.length) % results.length)
		} else if (event.key === "Enter") {
			event.preventDefault()
			openResult(entry)
		}
	}

	return (
		<SidebarPanel>
			<div className="flex flex-1 flex-col overflow-y-auto p-3 app-region-pane">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-medium">{t("common:settings")}</h2>
				<ListFilterInput
					value={query}
					onChange={changeQuery}
					placeholder={t("settingsSearchPlaceholder")}
					ariaLabel={t("settingsSearchPlaceholder")}
					wrapperClassName="mb-2 app-region-no-drag"
					inputRef={searchRef}
					onKeyDown={onSearchKeyDown}
					combobox={{
						listboxId,
						expanded: results.length > 0,
						activeDescendant: active >= 0 ? resultOptionId(listboxId, active) : undefined
					}}
				/>
				{searching ? (
					results.length === 0 ? (
						<p
							role="status"
							className="px-2.5 py-1.5 text-sm text-muted-foreground"
						>
							{t("settingsSearchNoResults")}
						</p>
					) : (
						// The box keeps focus and drives the list through aria-activedescendant; a row's mousedown leaves it there.
						<div
							id={listboxId}
							role="listbox"
							aria-label={t("settingsSearchResultsLabel")}
							className="flex flex-col gap-0.5"
						>
							{results.map((entry, index) => (
								<div
									key={entry.id}
									id={resultOptionId(listboxId, index)}
									role="option"
									aria-selected={index === active}
									className={cn(RESULT_CLASS, index === active && "bg-sidebar-accent text-sidebar-accent-foreground")}
									onMouseDown={event => {
										event.preventDefault()
									}}
									onClick={() => {
										setActiveIndex(index)
										openResult(entry)
									}}
								>
									<span className="w-full truncate">{i18n.t(entry.titleKey, { defaultValue: "" })}</span>
									<span className="w-full truncate text-xs text-muted-foreground">
										{i18n.t(APP_HELP_SECTION_LABELS[entry.section])}
									</span>
								</div>
							))}
						</div>
					)
				) : (
					<div className="flex flex-col gap-0.5">
						{SETTINGS_ITEMS.map(item => (
							<Link
								key={item.id}
								to={item.to}
								className={SIDEBAR_NAV_ITEM_CLASS}
								// The status is a description, not part of the name: the link stays "Security" for everything that
								// finds it by name.
								aria-label={item.id === "security" && keysNotExported ? t(item.labelKey) : undefined}
								aria-describedby={item.id === "security" && keysNotExported ? "settings-security-status" : undefined}
							>
								<item.icon className="text-muted-foreground group-data-[status=active]:text-primary" />
								<span className="truncate">{t(item.labelKey)}</span>
								{item.id === "security" && keysNotExported ? (
									<>
										<span
											id="settings-security-status"
											className="sr-only"
										>
											{t("settingsMasterKeysNotExportedStatus")}
										</span>
										<RailStatusDot
											dot="attention"
											className="ml-auto"
										/>
									</>
								) : null}
							</Link>
						))}
					</div>
				)}
			</div>
		</SidebarPanel>
	)
}
