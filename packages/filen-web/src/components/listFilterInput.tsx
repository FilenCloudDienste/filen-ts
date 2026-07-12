import { SearchIcon, XIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export interface ListFilterInputProps {
	value: string
	onChange: (value: string) => void
	placeholder: string
	ariaLabel: string
}

// H7's shared filter box for the picker surfaces that have no reason to hijack a global keyboard
// shortcut the way drive's own SearchInput does (mod+f + its Kbd hint make sense for a full listing,
// not a modal's contact list): the move/import destination picker and the four contact/participant
// picker dialogs (share-recipient, chat-participant, note-participant, new-chat contact) all mount this
// instead. Same visual chrome (icon-left, clear-button-right Input), no keymap registration, no
// dialogOpen prop — a dialog's own focus trap already keeps this the only focusable search box in play.
export function ListFilterInput({ value, onChange, placeholder, ariaLabel }: ListFilterInputProps) {
	return (
		<div className="relative w-full shrink-0">
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
					aria-label={ariaLabel}
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
