import { useTranslation } from "react-i18next"
import { Trash2Icon, BanIcon } from "lucide-react"
import type { Contact } from "@filen/sdk-rs"
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

export interface ContactMenuContentProps {
	contact: Contact
	// Both only signal intent upward — the listing-level dialog host (contactsList.tsx) owns the
	// confirm and the actual mutation, mirroring drive's itemMenu.tsx: this component is presentation
	// only.
	onRemove: (contact: Contact) => void
	onBlock: (contact: Contact) => void
	disabled?: boolean | undefined
	// Set only when `disabled` is caused specifically by the app being offline — surfaced as each
	// item's native title.
	title?: string | undefined
}

// The contact-row ⋯ menu — always rendered as a MenuPrimitive.Popup inside a DropdownMenu Root/
// Trigger/Portal/Positioner (see contactRow.tsx's ContactActions, which owns that nesting), mirrors
// drive's DriveDropdownMenuContent exactly. Remove then Block, both destructive-styled (the locale
// catalog's own doc comments: "Only Remove and Block render as destructive"), Block LAST as the more
// severe of the two — it also prevents the other person from re-requesting, Remove alone does not.
export function ContactMenuContent({ contact, onRemove, onBlock, disabled, title }: ContactMenuContentProps) {
	const { t } = useTranslation("contacts")

	return (
		<DropdownMenuContent align="end">
			<DropdownMenuItem
				variant="destructive"
				disabled={disabled}
				title={title}
				onClick={() => {
					onRemove(contact)
				}}
			>
				<Trash2Icon aria-hidden="true" />
				{t("contactsActionRemove")}
			</DropdownMenuItem>
			<DropdownMenuItem
				variant="destructive"
				disabled={disabled}
				title={title}
				onClick={() => {
					onBlock(contact)
				}}
			>
				<BanIcon aria-hidden="true" />
				{t("contactsActionBlock")}
			</DropdownMenuItem>
		</DropdownMenuContent>
	)
}
