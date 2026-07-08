import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { contactDisplayName, contactInitials, isContactOnline } from "@/components/contacts/contacts-list.logic"
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

interface ContactRowShellProps {
	avatar?: string | undefined
	displayName: string
	email: string
	online?: boolean
	// Trailing slot: empty today, the per-row action buttons (accept/deny, cancel, remove/block,
	// unblock) render here.
	children?: ReactNode
}

// Every row variant below renders through this shell — only the source record and its presence
// differ per variant. AvatarImage/AvatarFallback/AvatarBadge are all direct children of Avatar (its
// Base UI Root): Fallback only renders itself while no image has loaded (Base UI's own
// imageLoadingStatus gate), and AvatarBadge's absolute positioning is anchored to Root's own
// `relative` container — nesting the badge inside Fallback instead would make it disappear the
// moment a contact's avatar image finishes loading.
function ContactRowShell({ avatar, displayName, email, online = false, children }: ContactRowShellProps) {
	const { t } = useTranslation("contacts")

	return (
		<div className="flex h-14 items-center gap-3 rounded-xl px-2 text-sm hover:bg-accent/50">
			<Avatar>
				{avatar !== undefined ? <AvatarImage src={avatar} /> : null}
				<AvatarFallback>{contactInitials(displayName)}</AvatarFallback>
				{online ? (
					<AvatarBadge>
						<span className="sr-only">{t("contactsPresenceOnline")}</span>
					</AvatarBadge>
				) : null}
			</Avatar>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{displayName}</p>
				<p className="truncate text-xs text-muted-foreground">{email}</p>
			</div>
			{children}
		</div>
	)
}

export interface ContactRowProps {
	contact: Contact
	children?: ReactNode
}

// An established contact — the only row kind that ever shows the presence dot (only Contact carries
// lastActive; requests and blocked contacts don't track it).
export function ContactRow({ contact, children }: ContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
			online={isContactOnline(contact.lastActive)}
		>
			{children}
		</ContactRowShell>
	)
}

export interface ContactRequestRowProps {
	// Shared by both the incoming (Requests) and outgoing (Pending) sections — both request kinds
	// render identically here; only the trailing action slot they'll eventually get differs
	// (accept/deny vs. cancel), which is entirely the caller's concern via `children`.
	request: ContactRequestIn | ContactRequestOut
	children?: ReactNode
}

export function ContactRequestRow({ request, children }: ContactRequestRowProps) {
	return (
		<ContactRowShell
			avatar={request.avatar}
			displayName={contactDisplayName(request)}
			email={request.email}
		>
			{children}
		</ContactRowShell>
	)
}

export interface BlockedContactRowProps {
	contact: BlockedContact
	children?: ReactNode
}

export function BlockedContactRow({ contact, children }: BlockedContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
		>
			{children}
		</ContactRowShell>
	)
}
