import type { Ref } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { KbdKeys } from "@/lib/keymap/kbd"

export interface ThreadSearchBarProps {
	// Mod+F with the bar already open selects the field again.
	inputRef: Ref<HTMLInputElement>
	query: string
	onQueryChange: (query: string) => void
	// 1-based position of the current match, 0 with none.
	position: number
	total: number
	onNext: () => void
	onPrevious: () => void
	onClose: () => void
	// Older history remains to be loaded: offers "Search older messages".
	canSearchOlder: boolean
	searchingOlder: boolean
	onSearchOlder: () => void
}

// The open conversation's compact search bar, over the top of the thread. Enter moves to the next (older) match and
// Shift+Enter to the previous one, as the browser's find does; Escape closes it.
export function ThreadSearchBar({
	inputRef,
	query,
	onQueryChange,
	position,
	total,
	onNext,
	onPrevious,
	onClose,
	canSearchOlder,
	searchingOlder,
	onSearchOlder
}: ThreadSearchBarProps) {
	const { t } = useTranslation("chats")
	const searching = query.trim().length > 0

	return (
		<div
			role="search"
			className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/50 px-3 py-1.5"
		>
			<Input
				ref={inputRef}
				autoFocus
				type="text"
				autoComplete="off"
				spellCheck={false}
				value={query}
				aria-label={t("chatThreadSearchLabel")}
				placeholder={t("chatThreadSearchLabel")}
				onChange={event => {
					onQueryChange(event.target.value)
				}}
				onKeyDown={event => {
					if (event.nativeEvent.isComposing) {
						return
					}

					if (event.key === "Enter") {
						event.preventDefault()

						if (event.shiftKey) {
							onPrevious()
						} else {
							onNext()
						}
					} else if (event.key === "Escape") {
						event.preventDefault()
						event.stopPropagation()
						onClose()
					}
				}}
				className="h-7 max-w-64 min-w-32 flex-1"
			/>
			<span
				aria-live="polite"
				className="min-w-14 px-1 text-xs text-muted-foreground tabular-nums"
			>
				{searching
					? total === 0
						? t("chatThreadSearchNoResults")
						: t("chatThreadSearchPosition", { current: position, total })
					: null}
			</span>
			<TooltipIconButton
				label={t("chatThreadSearchPrevious")}
				size="icon-xs"
				disabled={position <= 1}
				onClick={onPrevious}
			>
				<ChevronDownIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("chatThreadSearchNext")}
				size="icon-xs"
				disabled={position >= total}
				onClick={onNext}
			>
				<ChevronUpIcon />
			</TooltipIconButton>
			{searching ? (
				canSearchOlder ? (
					<Button
						variant="ghost"
						size="xs"
						disabled={searchingOlder}
						onClick={onSearchOlder}
					>
						{searchingOlder ? <Spinner className="size-3" /> : null}
						{t("chatThreadSearchOlder")}
					</Button>
				) : (
					<span className="px-1 text-xs text-muted-foreground">{t("chatThreadSearchAllLoaded")}</span>
				)
			) : null}
			<TooltipIconButton
				label={t("chatThreadSearchClose")}
				size="icon-xs"
				shortcut={<KbdKeys keys={["Esc"]} />}
				onClick={onClose}
				className="ms-auto"
			>
				<XIcon />
			</TooltipIconButton>
		</div>
	)
}
