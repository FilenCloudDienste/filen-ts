import type { KeyboardEvent, Ref } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { SearchIcon, XIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export interface ListFilterInputProps {
	value: string
	onChange: (value: string) => void
	placeholder: string
	ariaLabel: string
	wrapperClassName?: string
	inputRef?: Ref<HTMLInputElement>
	// Runs before the box's own Escape handling; a handler that prevents the default takes the key.
	onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
	// For a box that drives a listbox through aria-activedescendant (the combobox pattern).
	combobox?: { listboxId: string; expanded: boolean; activeDescendant: string | undefined }
}

// Shared filter box for surfaces that have no reason to hijack a global keyboard shortcut the way
// drive's own SearchInput does (mod+f + its Kbd hint make sense for a full listing, not a picker or a
// sidebar): the destination/contact/participant pickers and the notes/chats sidebars. Icon-left,
// clear-button-right Input, no keymap registration. Escape clears a non-empty value and stops there, so
// it never also reaches a document-level Escape action.
export function ListFilterInput({
	value,
	onChange,
	placeholder,
	ariaLabel,
	wrapperClassName,
	inputRef,
	onKeyDown,
	combobox
}: ListFilterInputProps) {
	const { t } = useTranslation("common")

	return (
		<div className={cn("relative w-full shrink-0", wrapperClassName)}>
			<SearchIcon
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				ref={inputRef}
				type="search"
				aria-label={ariaLabel}
				role={combobox === undefined ? undefined : "combobox"}
				aria-autocomplete={combobox === undefined ? undefined : "list"}
				aria-expanded={combobox?.expanded}
				aria-controls={combobox?.expanded === true ? combobox.listboxId : undefined}
				aria-activedescendant={combobox?.activeDescendant}
				placeholder={placeholder}
				value={value}
				onChange={event => {
					onChange(event.target.value)
				}}
				onKeyDown={event => {
					onKeyDown?.(event)

					if (event.defaultPrevented) {
						return
					}

					if (event.key === "Escape" && value.length > 0) {
						event.preventDefault()
						event.stopPropagation()
						onChange("")
					}
				}}
				// The clear button below stands in for the browser's own, which would sit beside it.
				className="pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{value.length > 0 ? (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={t("clearFilter")}
					className="absolute top-1/2 right-1.5 -translate-y-1/2"
					onClick={() => {
						onChange("")
					}}
				>
					<XIcon />
				</Button>
			) : null}
		</div>
	)
}
