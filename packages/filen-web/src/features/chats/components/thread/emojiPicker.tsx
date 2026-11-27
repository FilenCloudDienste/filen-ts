import { createElement, useEffect, useId, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import {
	AppleIcon,
	ClockIcon,
	FlagIcon,
	HandIcon,
	LightbulbIcon,
	PawPrintIcon,
	PlaneIcon,
	SearchIcon,
	ShapesIcon,
	SmileIcon,
	SmilePlusIcon,
	SparklesIcon,
	TrophyIcon,
	type LucideIcon
} from "lucide-react"
import type { EmojiSuggestion } from "@/features/chats/lib/emoji"
import {
	EMOJI_PICKER_CATEGORIES,
	emojiForRecentToken,
	emojiInsertText,
	emojiPickerCategoryItems,
	emojiRecentToken,
	searchEmojiPicker,
	type EmojiPickerCategory
} from "@/features/chats/lib/emojiPicker.logic"
import { applySkinTone, SKIN_TONES, type SkinTone } from "@/features/chats/lib/skinTone"
import { loadEmojiRecents, useEmojiRecents } from "@/features/chats/store/useEmojiRecents"
import { EmojiPickerGrid } from "@/features/chats/components/thread/emojiPickerGrid"
import type { ChatsKey } from "@/lib/i18n"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

const CATEGORY_FACTS: Readonly<Record<EmojiPickerCategory, { labelKey: ChatsKey; icon: LucideIcon }>> = {
	recent: { labelKey: "chatEmojiCategoryRecent", icon: ClockIcon },
	smileys: { labelKey: "chatEmojiCategorySmileys", icon: SmileIcon },
	people: { labelKey: "chatEmojiCategoryPeople", icon: HandIcon },
	nature: { labelKey: "chatEmojiCategoryNature", icon: PawPrintIcon },
	food: { labelKey: "chatEmojiCategoryFood", icon: AppleIcon },
	travel: { labelKey: "chatEmojiCategoryTravel", icon: PlaneIcon },
	activities: { labelKey: "chatEmojiCategoryActivities", icon: TrophyIcon },
	objects: { labelKey: "chatEmojiCategoryObjects", icon: LightbulbIcon },
	symbols: { labelKey: "chatEmojiCategorySymbols", icon: ShapesIcon },
	flags: { labelKey: "chatEmojiCategoryFlags", icon: FlagIcon },
	custom: { labelKey: "chatEmojiCategoryCustom", icon: SparklesIcon }
}

const SKIN_TONE_LABELS: Readonly<Record<SkinTone, ChatsKey>> = {
	0: "chatEmojiSkinToneDefault",
	1: "chatEmojiSkinToneLight",
	2: "chatEmojiSkinToneMediumLight",
	3: "chatEmojiSkinToneMedium",
	4: "chatEmojiSkinToneMediumDark",
	5: "chatEmojiSkinToneDark"
}

// The raised hand (U+270B, which takes a tone on its one part) as each skin tone choice shows it.
function skinToneSample(tone: SkinTone): string {
	return applySkinTone("\u270b", "0", tone)
}

function categoryItems(category: EmojiPickerCategory, recents: readonly string[]): readonly EmojiSuggestion[] {
	if (category !== "recent") {
		return emojiPickerCategoryItems(category)
	}

	return recents.flatMap(token => {
		const item = emojiForRecentToken(token)

		return item !== undefined ? [item] : []
	})
}

// The popover's body, mounted only while it is open: no item list is built and no recent read starts before the first
// open. Focus starts in the search field; ArrowDown moves it into the grid, Enter in the field picks the first match.
function EmojiPickerBody({
	searchRef,
	onPick
}: {
	searchRef: RefObject<HTMLInputElement | null>
	onPick: (item: EmojiSuggestion, tone: SkinTone) => void
}) {
	const { t } = useTranslation("chats")
	const recents = useEmojiRecents(state => state.recents)
	const skinTone = useEmojiRecents(state => state.skinTone)
	const [toneChoicesOpen, setToneChoicesOpen] = useState(false)
	// Opens on the recently used tab when there is one to show.
	const [category, setCategory] = useState<EmojiPickerCategory>(() =>
		useEmojiRecents.getState().recents.length > 0 ? "recent" : "smileys"
	)
	const [query, setQuery] = useState("")
	const [activeIndex, setActiveIndex] = useState(0)
	const gridRef = useRef<HTMLDivElement | null>(null)
	const gridId = useId()
	const searching = query.trim().length > 0
	const items = searching ? searchEmojiPicker(query) : categoryItems(category, recents)
	const gridLabel = searching ? t("chatEmojiPickerResults") : t(CATEGORY_FACTS[category].labelKey)

	useEffect(() => {
		void loadEmojiRecents()
	}, [])

	return (
		<>
			<div className="flex items-center gap-1">
				<div className="relative min-w-0 flex-1">
					<SearchIcon
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						ref={searchRef}
						type="search"
						value={query}
						onChange={event => {
							setQuery(event.target.value)
							setActiveIndex(0)
						}}
						onKeyDown={event => {
							if (event.key === "ArrowDown" && items.length > 0) {
								event.preventDefault()
								gridRef.current?.focus()

								return
							}

							if (event.key === "Enter") {
								event.preventDefault()

								const item = items[Math.min(activeIndex, items.length - 1)]

								if (item !== undefined) {
									onPick(item, skinTone)
								}
							}
						}}
						aria-label={t("chatEmojiPickerSearch")}
						aria-controls={gridId}
						placeholder={t("chatEmojiPickerSearch")}
						autoComplete="off"
						spellCheck={false}
						className="h-8 w-full rounded-xl bg-muted py-1 pr-2 pl-8 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					/>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="shrink-0 rounded-full text-lg"
								aria-label={t("chatEmojiSkinTone")}
								aria-expanded={toneChoicesOpen}
								onClick={() => {
									setToneChoicesOpen(open => !open)
								}}
							>
								<span aria-hidden="true">{skinToneSample(skinTone)}</span>
							</Button>
						}
					/>
					<TooltipContent>{t("chatEmojiSkinTone")}</TooltipContent>
				</Tooltip>
			</div>
			{toneChoicesOpen ? (
				<div
					role="radiogroup"
					aria-label={t("chatEmojiSkinTone")}
					className="flex justify-between rounded-xl bg-muted p-1"
				>
					{SKIN_TONES.map(tone => (
						<button
							key={tone}
							type="button"
							role="radio"
							aria-checked={tone === skinTone}
							aria-label={t(SKIN_TONE_LABELS[tone])}
							title={t(SKIN_TONE_LABELS[tone])}
							className={cn(
								"flex size-8 items-center justify-center rounded-lg text-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
								tone === skinTone ? "bg-accent" : "hover:bg-accent/50"
							)}
							onClick={() => {
								useEmojiRecents.getState().setSkinTone(tone)
								setToneChoicesOpen(false)
								searchRef.current?.focus()
							}}
						>
							<span aria-hidden="true">{skinToneSample(tone)}</span>
						</button>
					))}
				</div>
			) : null}
			<Tabs
				value={category}
				onValueChange={value => {
					const next = EMOJI_PICKER_CATEGORIES.find(entry => entry === value)

					if (next === undefined) {
						return
					}

					setCategory(next)
					setQuery("")
					setActiveIndex(0)
				}}
				className="gap-1"
			>
				<TabsList
					variant="line"
					className="w-full justify-between"
				>
					{EMOJI_PICKER_CATEGORIES.map(entry => {
						const label = t(CATEGORY_FACTS[entry].labelKey)

						return (
							<TabsTrigger
								key={entry}
								value={entry}
								aria-label={label}
								title={label}
								className="flex-none px-1"
								onClick={() => {
									// The selected tab fires no value change; clicking it during a search goes back to its list.
									if (entry === category && searching) {
										setQuery("")
										setActiveIndex(0)
									}
								}}
							>
								{createElement(CATEGORY_FACTS[entry].icon, { "aria-hidden": true })}
							</TabsTrigger>
						)
					})}
				</TabsList>
				<TabsContent value={category}>
					{items.length > 0 ? (
						<EmojiPickerGrid
							// A new list starts at its top: remounting resets the scroller, so the first match (what Enter in
							// the search field picks) and the active cell are in view after a search edit or a tab switch.
							key={searching ? `search:${query}` : category}
							gridId={gridId}
							gridRef={gridRef}
							label={gridLabel}
							items={items}
							activeIndex={activeIndex}
							skinTone={skinTone}
							onActiveIndexChange={setActiveIndex}
							onPick={item => {
								onPick(item, skinTone)
							}}
						/>
					) : (
						<p className="flex h-64 items-center justify-center px-4 text-center text-sm text-muted-foreground">
							{searching ? t("chatEmojiPickerNoResults") : t("chatEmojiPickerNoRecent")}
						</p>
					)}
				</TabsContent>
			</Tabs>
		</>
	)
}

// The composer's emoji button and its popover. A pick closes the popover and focus goes back to the message field
// (`returnFocusRef`), as it does on Escape; the composer inserts the pick at the field's caret.
export function EmojiPicker({
	returnFocusRef,
	onPick
}: {
	returnFocusRef: RefObject<HTMLTextAreaElement | null>
	onPick: (text: string) => void
}) {
	const { t } = useTranslation("chats")
	const [open, setOpen] = useState(false)
	const searchRef = useRef<HTMLInputElement | null>(null)

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									className="rounded-full text-muted-foreground"
									aria-label={t("chatComposerEmoji")}
								>
									<SmilePlusIcon />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{t("chatComposerEmoji")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				side="top"
				align="start"
				initialFocus={searchRef}
				finalFocus={returnFocusRef}
				aria-label={t("chatComposerEmoji")}
				className="w-80 gap-2 rounded-2xl p-2"
			>
				<EmojiPickerBody
					searchRef={searchRef}
					onPick={(item, tone) => {
						useEmojiRecents.getState().record(emojiRecentToken(item))
						onPick(emojiInsertText(item, tone))
						setOpen(false)
					}}
				/>
			</PopoverContent>
		</Popover>
	)
}
