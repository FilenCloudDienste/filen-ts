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
}

// Shared filter box for surfaces that have no reason to hijack a global keyboard shortcut the way
// drive's own SearchInput does (mod+f + its Kbd hint make sense for a full listing, not a picker or a
// sidebar): the destination/contact/participant pickers and the notes/chats sidebars. Icon-left,
// clear-button-right Input, no keymap registration. Escape clears a non-empty value and stops there, so
// it never also reaches a document-level Escape action.
export function ListFilterInput({ value, onChange, placeholder, ariaLabel, wrapperClassName }: ListFilterInputProps) {
	const { t } = useTranslation("common")

	return (
		<div className={cn("relative w-full shrink-0", wrapperClassName)}>
			<SearchIcon
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				type="search"
				aria-label={ariaLabel}
				placeholder={placeholder}
				value={value}
				onChange={event => {
					onChange(event.target.value)
				}}
				onKeyDown={event => {
					if (event.key === "Escape" && value.length > 0) {
						event.preventDefault()
						event.stopPropagation()
						onChange("")
					}
				}}
				className="pr-8 pl-8"
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
