import { type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, XIcon, MoreHorizontalIcon, RotateCcwIcon } from "lucide-react"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { contactDisplayName, contactInitials } from "@/features/contacts/components/contactsList.logic"
import { ContactMenuContent } from "@/features/contacts/components/contactMenu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface ContactRowShellProps {
	avatar?: string | undefined
	displayName: string
	email: string
	// Selection state, shared by both contracts below; meaningless without one of them.
	selected?: boolean | undefined
	// Contract A — bounded dialog picker (drive's ContactPickerDialog, chats' CreateChatDialog): the row
	// owns its own Enter/Space toggle and is unconditionally tabbable. Correct where the list is short,
	// fixed-height and its trailing slot holds a glyph rather than controls.
	onToggleSelect?: (() => void) | undefined
	// Contract B — the contacts page's section listbox: the container owns key handling (it is the only
	// scope holding the section's uuid array), so the row takes a click handler, a roving cursor flag and
	// a ref instead of an onKeyDown. `active` is what makes this row the section's single Tab stop
	// (driveRow.tsx's identical rule).
	onSelect?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined
	active?: boolean | undefined
	rowRef?: ((element: HTMLDivElement | null) => void) | undefined
	// Trailing slot: the per-row action buttons/menu (accept/deny, cancel, remove/block, unblock), or a
	// picker's non-interactive check glyph.
	children?: ReactNode
}

// Every row variant below renders through this shell — only the source record differs per variant.
// AvatarImage/AvatarFallback are direct children of Avatar (its Base UI Root): Fallback only renders
// itself while no image has loaded (Base UI's own imageLoadingStatus gate).
function ContactRowShell({
	avatar,
	displayName,
	email,
	selected,
	onToggleSelect,
	onSelect,
	active,
	rowRef,
	children
}: ContactRowShellProps) {
	const roving = onSelect !== undefined
	const selectable = roving || onToggleSelect !== undefined

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.key !== "Enter" && event.key !== " ") {
			return
		}

		event.preventDefault()
		onToggleSelect?.()
	}

	// One Tab stop per section listbox under contract B, the row's own stop under contract A.
	function resolveTabIndex(): number | undefined {
		if (!selectable) {
			return undefined
		}

		if (!roving) {
			return 0
		}

		return active === true ? 0 : -1
	}

	return (
		<div
			ref={rowRef}
			role={selectable ? "option" : undefined}
			aria-selected={selectable ? selected === true : undefined}
			tabIndex={resolveTabIndex()}
			onClick={onSelect ?? onToggleSelect}
			onKeyDown={onToggleSelect === undefined ? undefined : handleKeyDown}
			className={cn(
				"flex h-14 items-center gap-3 rounded-xl px-2 text-sm",
				selectable
					? "cursor-pointer focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
					: "hover:bg-accent/50"
			)}
		>
			<Avatar>
				{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin egest
				    url (see settings/account/avatarCard.tsx's matching comment for the verified detail). */}
				{avatar !== undefined ? (
					<AvatarImage
						src={avatar}
						crossOrigin="anonymous"
					/>
				) : null}
				<AvatarFallback>{contactInitials(displayName)}</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{displayName}</p>
				<p className="truncate text-xs text-muted-foreground">{email}</p>
			</div>
			{roving ? (
				<div
					className="flex shrink-0 items-center gap-2"
					onClick={event => {
						// Acting on a row must not also select it — the same guard driveRow.tsx puts on its own
						// menu trigger, hoisted to the whole slot since contacts has four different ones. A
						// picker (contract A) must NOT get this: its slot holds a check glyph inside a row whose
						// entire surface is the toggle target.
						event.stopPropagation()
					}}
				>
					{children}
				</div>
			) : (
				children
			)}
		</div>
	)
}

export interface ContactRowProps {
	contact: Contact
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	onSelect?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined
	active?: boolean | undefined
	rowRef?: ((element: HTMLDivElement | null) => void) | undefined
	children?: ReactNode
}

export function ContactRow({ contact, selected, onToggleSelect, onSelect, active, rowRef, children }: ContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
			selected={selected}
			onToggleSelect={onToggleSelect}
			onSelect={onSelect}
			active={active}
			rowRef={rowRef}
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
	onSelect?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined
	active?: boolean | undefined
	rowRef?: ((element: HTMLDivElement | null) => void) | undefined
	children?: ReactNode
}

export function ContactRequestRow({ request, selected, onToggleSelect, onSelect, active, rowRef, children }: ContactRequestRowProps) {
	return (
		<ContactRowShell
			avatar={request.avatar}
			displayName={contactDisplayName(request)}
			email={request.email}
			selected={selected}
			onToggleSelect={onToggleSelect}
			onSelect={onSelect}
			active={active}
			rowRef={rowRef}
		>
			{children}
		</ContactRowShell>
	)
}

export interface BlockedContactRowProps {
	contact: BlockedContact
	selected?: boolean | undefined
	onToggleSelect?: (() => void) | undefined
	onSelect?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined
	active?: boolean | undefined
	rowRef?: ((element: HTMLDivElement | null) => void) | undefined
	children?: ReactNode
}

export function BlockedContactRow({ contact, selected, onToggleSelect, onSelect, active, rowRef, children }: BlockedContactRowProps) {
	return (
		<ContactRowShell
			avatar={contact.avatar}
			displayName={contactDisplayName(contact)}
			email={contact.email}
			selected={selected}
			onToggleSelect={onToggleSelect}
			onSelect={onSelect}
			active={active}
			rowRef={rowRef}
		>
			{children}
		</ContactRowShell>
	)
}

// ── Per-row action slots ─────────────────────────────────────────────────
// Every component below only signals intent upward via callback props — none of them call an action
// helper or open a confirm dialog directly. contactsList.tsx's dialog host owns every confirm +
// mutation, mirroring drive's itemMenu.tsx (dialog-routed descriptors report a kind, the listing
// resolves it) — the one exception is Accept, which runs with no confirm (mirrors mobile), so it's
// still just a reported intent (the caller runs it immediately instead of opening a dialog).

export interface IncomingRequestActionsProps {
	request: ContactRequestIn
	onAccept: (request: ContactRequestIn) => void
	onDeny: (request: ContactRequestIn) => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — surfaced as each
	// button's native title.
	title?: string | undefined
	// Only the cursor row's controls join the normal Tab sequence (driveRow.tsx's own rule) — otherwise
	// every visible row would add its own Tab stops to an unvirtualized list.
	tabIndex?: number
}

export function IncomingRequestActions({ request, onAccept, onDeny, disabled, title, tabIndex }: IncomingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<div className="flex shrink-0 items-center gap-2">
			<Button
				variant="outline"
				size="icon-sm"
				disabled={disabled}
				aria-label={t("contactsActionAccept")}
				title={title}
				tabIndex={tabIndex}
				onClick={() => {
					onAccept(request)
				}}
			>
				<CheckIcon aria-hidden="true" />
			</Button>
			<Button
				variant="outline"
				size="icon-sm"
				disabled={disabled}
				aria-label={t("contactsActionDeny")}
				title={title}
				tabIndex={tabIndex}
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
	disabled?: boolean
	title?: string | undefined
	tabIndex?: number
}

export function OutgoingRequestActions({ request, onCancel, disabled, title, tabIndex }: OutgoingRequestActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="icon-sm"
			disabled={disabled}
			aria-label={t("contactsActionCancelRequest")}
			title={title}
			tabIndex={tabIndex}
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
	onMessage: (contact: Contact) => void
	onRemove: (contact: Contact) => void
	onBlock: (contact: Contact) => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — threaded to
	// ContactMenuContent's own items (the trigger itself always opens the menu, never disabled).
	title?: string | undefined
	tabIndex?: number
}

// DropdownMenu Root > Trigger + Content, mirroring driveRow.tsx's exact nesting for its own ⋯
// dropdown: Trigger is a render-prop'd Button (not a child), Content (ContactMenuContent, which
// already wraps Portal>Positioner>Popup) is the Root's other direct child.
export function ContactActions({ contact, onMessage, onRemove, onBlock, disabled, title, tabIndex }: ContactActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("contactsRowMenuTrigger")}
						tabIndex={tabIndex}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Button>
				}
			/>
			<ContactMenuContent
				contact={contact}
				onMessage={onMessage}
				onRemove={onRemove}
				onBlock={onBlock}
				disabled={disabled}
				title={title}
			/>
		</DropdownMenu>
	)
}

export interface BlockedActionsProps {
	contact: BlockedContact
	onUnblock: (contact: BlockedContact) => void
	disabled?: boolean
	title?: string | undefined
	tabIndex?: number
}

export function BlockedActions({ contact, onUnblock, disabled, title, tabIndex }: BlockedActionsProps) {
	const { t } = useTranslation("contacts")

	return (
		<Button
			variant="outline"
			size="sm"
			disabled={disabled}
			title={title}
			tabIndex={tabIndex}
			onClick={() => {
				onUnblock(contact)
			}}
		>
			<RotateCcwIcon aria-hidden="true" />
			{t("contactsActionUnblock")}
		</Button>
	)
}
