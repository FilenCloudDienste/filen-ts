import { type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, XIcon, MoreHorizontalIcon, RotateCcwIcon } from "lucide-react"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { contactDisplayName, contactInitials, isContactOnline } from "@/features/contacts/components/contactsList.logic"
import { ContactMenuContent } from "@/features/contacts/components/contactMenu"
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface ContactRowShellProps {
	avatar?: string | undefined
	displayName: string
	email: string
	online?: boolean
	// Present only while the listing is in bulk-selection mode — its presence (not its value) is what
	// turns the row into a clickable, selectable listbox option; `selected` is meaningless without it.
	// Mirrors DriveRow's role="option"/aria-selected treatment (drive/drive-row.tsx), no separate
	// checkbox glyph.
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	// Trailing slot: the per-row action buttons/menu (accept/deny, cancel, remove/block, unblock) in
	// normal mode; left empty while onToggleSelect is set — bulk mode hides per-row actions in favor
	// of the bulk bar (see contacts-list.tsx's renderSectionItems).
	children?: ReactNode
}

// Every row variant below renders through this shell — only the source record and its presence
// differ per variant. AvatarImage/AvatarFallback/AvatarBadge are all direct children of Avatar (its
// Base UI Root): Fallback only renders itself while no image has loaded (Base UI's own
// imageLoadingStatus gate), and AvatarBadge's absolute positioning is anchored to Root's own
// `relative` container — nesting the badge inside Fallback instead would make it disappear the
// moment a contact's avatar image finishes loading.
function ContactRowShell({ avatar, displayName, email, online = false, selected, onToggleSelect, children }: ContactRowShellProps) {
	const { t } = useTranslation("contacts")
	const selectable = onToggleSelect !== undefined

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.key !== "Enter" && event.key !== " ") {
			return
		}

		event.preventDefault()
		onToggleSelect?.()
	}

	return (
		<div
			role={selectable ? "option" : undefined}
			aria-selected={selectable ? selected === true : undefined}
			tabIndex={selectable ? 0 : undefined}
			onClick={selectable ? onToggleSelect : undefined}
			onKeyDown={selectable ? handleKeyDown : undefined}
			className={cn(
				"flex h-14 items-center gap-3 rounded-xl px-2 text-sm",
				selectable
					? "cursor-pointer outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
					: "hover:bg-accent/50"
			)}
		>
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
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	children?: ReactNode
}

// An established contact — the only row kind that ever shows the presence dot (only Contact carries
// lastActive; requests and blocked contacts don't track it).
export function ContactRow({ contact, selected, onToggleSelect, children }: ContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
			online={isContactOnline(contact.lastActive)}
			selected={selected}
			onToggleSelect={onToggleSelect}
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
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	children?: ReactNode
}

export function ContactRequestRow({ request, selected, onToggleSelect, children }: ContactRequestRowProps) {
	return (
		<ContactRowShell
			avatar={request.avatar}
			displayName={contactDisplayName(request)}
			email={request.email}
			selected={selected}
			onToggleSelect={onToggleSelect}
		>
			{children}
		</ContactRowShell>
	)
}

export interface BlockedContactRowProps {
	contact: BlockedContact
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	children?: ReactNode
}

export function BlockedContactRow({ contact, selected, onToggleSelect, children }: BlockedContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
			selected={selected}
			onToggleSelect={onToggleSelect}
		>
			{children}
		</ContactRowShell>
	)
}

// ── Per-row action slots ─────────────────────────────────────────────────
// Every component below only signals intent upward via callback props — none of them call an action
// helper or open a confirm dialog directly. contacts-list.tsx's dialog host owns every confirm +
// mutation, mirroring drive's item-menu.tsx (dialog-routed descriptors report a kind, the listing
// resolves it) — the one exception is Accept, which runs with no confirm (mirrors mobile), so it's
// still just a reported intent (the caller runs it immediately instead of opening a dialog).

export interface IncomingRequestActionsProps {
	request: ContactRequestIn
	onAccept: (request: ContactRequestIn) => void
	onDeny: (request: ContactRequestIn) => void
}

export function IncomingRequestActions({ request, onAccept, onDeny }: IncomingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<div className="flex shrink-0 items-center gap-2">
			<Button
				variant="outline"
				size="icon-sm"
				aria-label={t("contactsActionAccept")}
				onClick={() => {
					onAccept(request)
				}}
			>
				<CheckIcon aria-hidden="true" />
			</Button>
			<Button
				variant="outline"
				size="icon-sm"
				aria-label={t("contactsActionDeny")}
				onClick={() => {
					onDeny(request)
				}}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</div>
	)
}

export interface OutgoingRequestActionsProps {
	request: ContactRequestOut
	onCancel: (request: ContactRequestOut) => void
}

export function OutgoingRequestActions({ request, onCancel }: OutgoingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="icon-sm"
			aria-label={t("contactsActionCancelRequest")}
			onClick={() => {
				onCancel(request)
			}}
		>
			<XIcon aria-hidden="true" />
		</Button>
	)
}

export interface ContactActionsProps {
	contact: Contact
	onRemove: (contact: Contact) => void
	onBlock: (contact: Contact) => void
}

// DropdownMenu Root > Trigger + Content, mirroring drive-row.tsx's exact nesting for its own ⋯
// dropdown: Trigger is a render-prop'd Button (not a child), Content (ContactMenuContent, which
// already wraps Portal>Positioner>Popup) is the Root's other direct child.
export function ContactActions({ contact, onRemove, onBlock }: ContactActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("contactsRowMenuTrigger")}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Button>
				}
			/>
			<ContactMenuContent
				contact={contact}
				onRemove={onRemove}
				onBlock={onBlock}
			/>
		</DropdownMenu>
	)
}

export interface BlockedActionsProps {
	contact: BlockedContact
	onUnblock: (contact: BlockedContact) => void
}

export function BlockedActions({ contact, onUnblock }: BlockedActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="sm"
			onClick={() => {
				onUnblock(contact)
			}}
		>
			<RotateCcwIcon aria-hidden="true" />
			{t("contactsActionUnblock")}
		</Button>
	)
}
