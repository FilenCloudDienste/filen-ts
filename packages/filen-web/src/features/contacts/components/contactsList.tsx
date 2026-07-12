import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { SearchIcon, UsersIcon, ListChecksIcon } from "lucide-react"
import { toast } from "sonner"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { useContactsQuery, useContactRequestsQuery } from "@/features/contacts/queries/contacts"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useDialogHost } from "@/lib/useDialogHost"
import { useIsOnline } from "@/lib/useIsOnline"
import {
	buildContactSections,
	filterContactSections,
	contactsStatsCounts,
	CONTACTS_SECTION_HEADER_KEY,
	type ContactSection,
	type ContactsSectionFilter
} from "@/features/contacts/components/contactsList.logic"
import {
	acceptRequest,
	denyRequest,
	cancelRequest,
	removeContact,
	blockContact,
	unblockContact,
	messageContact,
	runContactsBulk,
	type VoidActionOutcome
} from "@/features/contacts/lib/actions"
import { toastContactsBulkOutcome } from "@/features/contacts/lib/bulkToast"
import {
	EMPTY_CONTACT_SELECTION,
	toggleContactSelection,
	removeFromContactSelection,
	type ContactSelection,
	type ContactSectionKey
} from "@/features/contacts/lib/selection"
import {
	ContactRow,
	ContactRequestRow,
	BlockedContactRow,
	IncomingRequestActions,
	OutgoingRequestActions,
	ContactActions,
	BlockedActions
} from "@/features/contacts/components/contactRow"
import { AddContactDialog } from "@/features/contacts/components/addContactDialog"
import { ContactsBulkBar } from "@/features/contacts/components/contactsBulkBar"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

const SKELETON_ROW_COUNT = 6

// One stat tile in the summary strip above the list — count + label, no drill-down (see the strip's
// own render-site doc comment below for why a lightweight strip beats an invented detail pane).
function ContactsStatTile({ count, label }: { count: number; label: string }) {
	return (
		<div className="flex flex-col items-center gap-0.5 rounded-xl bg-muted/50 py-3 ring-1 ring-foreground/5 dark:ring-foreground/10">
			<span className="text-lg font-semibold tabular-nums">{count}</span>
			<span className="text-xs text-muted-foreground">{label}</span>
		</div>
	)
}

// The per-kind dialog payload threaded through useDialogHost, widened with a `bulk` flag: every kind
// here can be reached either from a single row's own action (bulk: false, a 1-length items array) or
// from the bulk bar (bulk: true, the whole gated section selection) — same dialog, same title/body
// (the count just interpolates), only the confirm handler's run-single-vs-run-bulk branch differs.
// Accept has no dialog kind: it never confirms (mirrors mobile), so it never reaches this host.
type ActiveContactDialog =
	| { kind: "deny"; bulk: boolean; items: ContactRequestIn[] }
	| { kind: "cancel"; bulk: boolean; items: ContactRequestOut[] }
	| { kind: "remove"; bulk: boolean; items: Contact[] }
	| { kind: "block"; bulk: boolean; items: Contact[] }
	| { kind: "unblock"; bulk: boolean; items: BlockedContact[] }

// Owns both contacts queries, the search box's local state, bulk-selection mode, and the whole
// status-branch (loading skeleton / load-error / empty / sectioned list) — mirrors DirectoryListing's
// own self-contained shape (route files stay thin; the content component owns its data + its dialog
// host). `section` is owned by the route (its own `section` search param, see
// routes/_app/contacts.tsx) — the sidebar and this page are siblings under appShell, not
// parent/child, so the URL is their one shared source of truth for which section is active.
export function ContactsList({ section }: { section: ContactsSectionFilter }) {
	const { t } = useTranslation(["contacts", "common"])
	const navigate = useNavigate()
	const isOnline = useIsOnline()
	// Every per-row/bulk action below is disabled SOLELY by `!isOnline` (no other reason ever
	// disables them), so this single string doubles as both the "why" and the disabled condition's own
	// explanation — computed once rather than re-deriving `t("common:offlineActionDisabled")` at each
	// of the 6 call sites below.
	const offlineTitle = !isOnline ? t("common:offlineActionDisabled") : undefined
	const [search, setSearch] = useState("")
	const [selectMode, setSelectMode] = useState(false)
	const [selection, setSelection] = useState<ContactSelection>(EMPTY_CONTACT_SELECTION)
	const { activeDialog, setActiveDialog, dialogPending, setDialogPending, closeActiveDialog } = useDialogHost<ActiveContactDialog>()

	const contactsQuery = useContactsQuery()
	const requestsQuery = useContactRequestsQuery()

	const isPending = contactsQuery.status === "pending" || requestsQuery.status === "pending"
	// At most one of these can be an actual Error at a time in practice, but either query can fail
	// independently — check contacts first, requests second; a retry always refetches both regardless
	// of which one is shown, so which one "wins" the display only affects the error copy.
	const queryError =
		contactsQuery.status === "error" ? contactsQuery.error : requestsQuery.status === "error" ? requestsQuery.error : null

	const contactsData = contactsQuery.data?.contacts ?? []
	const blockedData = contactsQuery.data?.blocked ?? []
	const incomingData = requestsQuery.data?.incoming ?? []
	const outgoingData = requestsQuery.data?.outgoing ?? []
	const stats = contactsStatsCounts({ contacts: contactsData, incoming: incomingData, blocked: blockedData })

	// search-filtered, every section — the base every the sidebar's "all" view renders, and also what
	// tells the empty branch below whether the account genuinely has nothing (searchedSections empty
	// too) or just nothing in the CURRENTLY selected section (searchedSections non-empty, but the
	// section-narrowed `sections` below is).
	const searchedSections = buildContactSections({
		contacts: contactsData,
		blocked: blockedData,
		incoming: incomingData,
		outgoing: outgoingData,
		search
	})
	const sections = filterContactSections(searchedSections, section)

	function handleRetry(): void {
		void contactsQuery.refetch()
		void requestsQuery.refetch()
	}

	function toggleSelect(section: ContactSectionKey, uuid: string): void {
		setSelection(prev => toggleContactSelection(prev, section, uuid))
	}

	function pruneSelection(section: ContactSectionKey, uuids: string[]): void {
		if (uuids.length === 0) {
			return
		}

		setSelection(prev => removeFromContactSelection(prev, section, uuids))
	}

	function exitSelectMode(): void {
		setSelectMode(false)
		setSelection(EMPTY_CONTACT_SELECTION)
	}

	// No confirm (mirrors mobile) — silent success, LABEL-FIRST toast on failure, matching every
	// other singular contact action's convention (see runSingleDialogAction below).
	async function handleAccept(request: ContactRequestIn): Promise<void> {
		const outcome = await acceptRequest(request.uuid)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// Row menu "Message" (new#… quick action): creates-or-opens a 1:1 chat with the contact, then
	// navigates straight into it — no confirm (mirrors mobile's own one-click contactRow.tsx handler),
	// LABEL-FIRST toast on failure, matching every other singular contact action's convention.
	async function handleMessage(contact: Contact): Promise<void> {
		const outcome = await messageContact(contact, {
			onChatReady: chat => {
				void navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } })
			}
		})

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleBulkAccept(items: ContactRequestIn[]): Promise<void> {
		const outcome = await runContactsBulk(items, request => acceptRequest(request.uuid))
		toastContactsBulkOutcome(outcome)
		pruneSelection(
			"requests",
			outcome.succeeded.map(request => request.uuid)
		)
	}

	// Shared tail for a per-row single confirm: run the singular action helper, close silently on
	// success, toast + stay open (so the user can retry) on failure — mirrors directoryListing.tsx's
	// rename handler, the closest single-item (non-bulk-shaped) precedent there.
	async function runSingleDialogAction<T>(item: T, op: (item: T) => Promise<VoidActionOutcome>): Promise<void> {
		setDialogPending(true)
		const outcome = await op(item)
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		closeActiveDialog()
	}

	// Shared tail for a bulk confirm: run every item independently via runContactsBulk, always close
	// (the toast conveys any partial failure), and prune succeeded uuids from the selection — mirrors
	// directoryListing.tsx's runBulkDialogAction.
	async function runBulkDialogAction<T>(
		section: ContactSectionKey,
		items: T[],
		op: (item: T) => Promise<VoidActionOutcome>,
		uuidOf: (item: T) => string
	): Promise<void> {
		setDialogPending(true)
		const outcome = await runContactsBulk(items, op)
		setDialogPending(false)
		closeActiveDialog()
		toastContactsBulkOutcome(outcome)
		pruneSelection(section, outcome.succeeded.map(uuidOf))
	}

	// One instance of whichever dialog is active, switching on activeDialog.kind — never more than one
	// mounted at a time. Only remove/block render `destructive` (the locale catalog's own doc
	// comments: deny/cancel/unblock never are, despite mobile flagging deny/cancel that way).
	function renderActiveDialog(): ReactNode {
		if (!activeDialog) {
			return null
		}

		switch (activeDialog.kind) {
			case "deny": {
				const { items, bulk } = activeDialog

				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("contactsDenyConfirmTitle")}
						body={t("contactsDenyConfirmBody", { count: items.length })}
						confirmLabel={t("contactsActionDeny")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							if (bulk) {
								void runBulkDialogAction(
									"requests",
									items,
									request => denyRequest(request.uuid),
									request => request.uuid
								)
								return
							}

							const item = items[0]

							if (!item) {
								return
							}

							void runSingleDialogAction(item, request => denyRequest(request.uuid))
						}}
					/>
				)
			}
			case "cancel": {
				const { items, bulk } = activeDialog

				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("contactsCancelConfirmTitle")}
						body={t("contactsCancelConfirmBody", { count: items.length })}
						confirmLabel={t("contactsActionCancelRequest")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							if (bulk) {
								void runBulkDialogAction(
									"pending",
									items,
									request => cancelRequest(request.uuid),
									request => request.uuid
								)
								return
							}

							const item = items[0]

							if (!item) {
								return
							}

							void runSingleDialogAction(item, request => cancelRequest(request.uuid))
						}}
					/>
				)
			}
			case "remove": {
				const { items, bulk } = activeDialog

				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("contactsRemoveConfirmTitle")}
						body={t("contactsRemoveConfirmBody", { count: items.length })}
						confirmLabel={t("contactsActionRemove")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							if (bulk) {
								void runBulkDialogAction(
									"contacts",
									items,
									contact => removeContact(contact.uuid),
									contact => contact.uuid
								)
								return
							}

							const item = items[0]

							if (!item) {
								return
							}

							void runSingleDialogAction(item, contact => removeContact(contact.uuid))
						}}
					/>
				)
			}
			case "block": {
				const { items, bulk } = activeDialog

				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("contactsBlockConfirmTitle")}
						body={t("contactsBlockConfirmBody", { count: items.length })}
						confirmLabel={t("contactsActionBlock")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							if (bulk) {
								void runBulkDialogAction(
									"contacts",
									items,
									contact => blockContact(contact),
									contact => contact.uuid
								)
								return
							}

							const item = items[0]

							if (!item) {
								return
							}

							void runSingleDialogAction(item, contact => blockContact(contact))
						}}
					/>
				)
			}
			case "unblock": {
				const { items, bulk } = activeDialog

				return (
					<ConfirmDialog
						open
						pending={dialogPending}
						title={t("contactsUnblockConfirmTitle")}
						body={t("contactsUnblockConfirmBody", { count: items.length })}
						confirmLabel={t("contactsActionUnblock")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								closeActiveDialog()
							}
						}}
						onConfirm={() => {
							if (bulk) {
								void runBulkDialogAction(
									"blocked",
									items,
									contact => unblockContact(contact.uuid),
									contact => contact.uuid
								)
								return
							}

							const item = items[0]

							if (!item) {
								return
							}

							void runSingleDialogAction(item, contact => unblockContact(contact.uuid))
						}}
					/>
				)
			}
		}
	}

	// One row per section item, dispatched on the section's own key — the key already discriminates
	// `items`' concrete type (see contactsList.logic.ts's ContactSection), so no per-item type tag is
	// needed the way mobile's flat single-list rendering requires one. In bulk-selection mode every row
	// becomes a selectable option instead (see contactRow.tsx's ContactRowShell) and the trailing
	// action slot is left empty — the bulk bar replaces the per-row actions entirely.
	function renderSectionItems(section: ContactSection): ReactNode {
		switch (section.key) {
			case "requests":
				return section.items.map(request => (
					<ContactRequestRow
						key={request.uuid}
						request={request}
						selected={selectMode ? selection.requests.has(request.uuid) : undefined}
						onToggleSelect={
							selectMode
								? () => {
										toggleSelect("requests", request.uuid)
									}
								: undefined
						}
					>
						{!selectMode ? (
							<IncomingRequestActions
								request={request}
								disabled={!isOnline}
								title={offlineTitle}
								onAccept={item => {
									void handleAccept(item)
								}}
								onDeny={item => {
									setActiveDialog({ kind: "deny", bulk: false, items: [item] })
								}}
							/>
						) : null}
					</ContactRequestRow>
				))
			case "pending":
				return section.items.map(request => (
					<ContactRequestRow
						key={request.uuid}
						request={request}
						selected={selectMode ? selection.pending.has(request.uuid) : undefined}
						onToggleSelect={
							selectMode
								? () => {
										toggleSelect("pending", request.uuid)
									}
								: undefined
						}
					>
						{!selectMode ? (
							<OutgoingRequestActions
								request={request}
								disabled={!isOnline}
								title={offlineTitle}
								onCancel={item => {
									setActiveDialog({ kind: "cancel", bulk: false, items: [item] })
								}}
							/>
						) : null}
					</ContactRequestRow>
				))
			case "contacts":
				return section.items.map(contact => (
					<ContactRow
						key={contact.uuid}
						contact={contact}
						selected={selectMode ? selection.contacts.has(contact.uuid) : undefined}
						onToggleSelect={
							selectMode
								? () => {
										toggleSelect("contacts", contact.uuid)
									}
								: undefined
						}
					>
						{!selectMode ? (
							<ContactActions
								contact={contact}
								disabled={!isOnline}
								title={offlineTitle}
								onMessage={item => {
									void handleMessage(item)
								}}
								onRemove={item => {
									setActiveDialog({ kind: "remove", bulk: false, items: [item] })
								}}
								onBlock={item => {
									setActiveDialog({ kind: "block", bulk: false, items: [item] })
								}}
							/>
						) : null}
					</ContactRow>
				))
			case "blocked":
				return section.items.map(blocked => (
					<BlockedContactRow
						key={blocked.uuid}
						contact={blocked}
						selected={selectMode ? selection.blocked.has(blocked.uuid) : undefined}
						onToggleSelect={
							selectMode
								? () => {
										toggleSelect("blocked", blocked.uuid)
									}
								: undefined
						}
					>
						{!selectMode ? (
							<BlockedActions
								contact={blocked}
								disabled={!isOnline}
								title={offlineTitle}
								onUnblock={item => {
									setActiveDialog({ kind: "unblock", bulk: false, items: [item] })
								}}
							/>
						) : null}
					</BlockedContactRow>
				))
		}
	}

	return (
		<>
			<header className="flex h-14 shrink-0 items-center px-4">
				<h1 className="text-sm font-medium">
					{section === "all" ? t("common:moduleContacts") : t(CONTACTS_SECTION_HEADER_KEY[section])}
				</h1>
			</header>
			{/* Centers the whole card at a comfortable reading width (mirrors EventsList's own max-w-2xl
			mx-auto treatment) — a short contact list reads as an intentional, room-to-grow card instead
			of a full-bleed panel stranded in blank space. Web-only polish, no mobile equivalent. */}
			<div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
				{!isPending && queryError === null ? (
					<div
						role="group"
						aria-label={t("contactsStatsSummaryLabel")}
						className="grid shrink-0 grid-cols-3 gap-2 px-4 pt-3"
					>
						<ContactsStatTile
							count={stats.contacts}
							label={t(CONTACTS_SECTION_HEADER_KEY.contacts)}
						/>
						<ContactsStatTile
							count={stats.requests}
							label={t(CONTACTS_SECTION_HEADER_KEY.requests)}
						/>
						<ContactsStatTile
							count={stats.blocked}
							label={t(CONTACTS_SECTION_HEADER_KEY.blocked)}
						/>
					</div>
				) : null}
				<div className="flex h-12 shrink-0 items-center justify-between gap-4 px-4">
					{selectMode ? (
						<ContactsBulkBar
							requests={incomingData}
							pending={outgoingData}
							contacts={contactsData}
							blocked={blockedData}
							selection={selection}
							disabled={!isOnline}
							title={offlineTitle}
							onClear={exitSelectMode}
							onAccept={items => {
								void handleBulkAccept(items)
							}}
							onDeny={items => {
								setActiveDialog({ kind: "deny", bulk: true, items })
							}}
							onCancel={items => {
								setActiveDialog({ kind: "cancel", bulk: true, items })
							}}
							onRemove={items => {
								setActiveDialog({ kind: "remove", bulk: true, items })
							}}
							onBlock={items => {
								setActiveDialog({ kind: "block", bulk: true, items })
							}}
							onUnblock={items => {
								setActiveDialog({ kind: "unblock", bulk: true, items })
							}}
						/>
					) : (
						<>
							<div className="relative max-w-xs flex-1">
								<SearchIcon
									aria-hidden="true"
									className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								/>
								<Input
									type="search"
									aria-label={t("contactsSearchPlaceholder")}
									placeholder={t("contactsSearchPlaceholder")}
									value={search}
									onChange={event => {
										setSearch(event.target.value)
									}}
									className="pl-8"
								/>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<AddContactDialog />
								<Button
									variant="outline"
									size="sm"
									disabled={isPending || queryError !== null || sections.length === 0}
									onClick={() => {
										setSelectMode(true)
									}}
								>
									<ListChecksIcon aria-hidden="true" />
									{t("contactsActionSelect")}
								</Button>
							</div>
						</>
					)}
				</div>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{isPending ? (
						<div className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
							{Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
								<Skeleton
									key={index}
									className="h-14 w-full rounded-xl"
								/>
							))}
						</div>
					) : queryError !== null ? (
						<div className="flex flex-1 overflow-y-auto">
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<UsersIcon />
									</EmptyMedia>
									<EmptyTitle>{t("contactsLoadError")}</EmptyTitle>
									<EmptyDescription>{errorLabel(asErrorDTO(queryError))}</EmptyDescription>
								</EmptyHeader>
								<EmptyContent>
									<Button
										variant="outline"
										onClick={handleRetry}
									>
										{t("common:tryAgain")}
									</Button>
								</EmptyContent>
							</Empty>
						</div>
					) : sections.length === 0 ? (
						// A non-matching SEARCH query always gets its own "no results" state, checked
						// first — searchedSections/sections both collapse to zero the moment a query matches
						// nothing, which previously fell through to the "genuinely no contacts" branch below and
						// showed the add-a-contact onboarding copy even on an account that has plenty of
						// contacts, just none matching. searchedSections is search-filtered but NOT
						// section-filtered, so (with no search active) empty here means genuinely nothing
						// matches anywhere (the generic empty state); non-empty means the account has data, just
						// none in the currently selected section (the narrower "nothing HERE" copy, no
						// add-contact CTA — that action isn't relevant to e.g. an empty Blocked view).
						<div className="flex flex-1 overflow-y-auto">
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">{search.trim().length > 0 ? <SearchIcon /> : <UsersIcon />}</EmptyMedia>
									{search.trim().length > 0 ? (
										<>
											<EmptyTitle>{t("contactsSearchNoResultsTitle")}</EmptyTitle>
											<EmptyDescription>{t("contactsSearchNoResultsBody")}</EmptyDescription>
										</>
									) : searchedSections.length === 0 ? (
										<>
											<EmptyTitle>{t("contactsEmptyTitle")}</EmptyTitle>
											<EmptyDescription>{t("contactsEmptyBody")}</EmptyDescription>
										</>
									) : (
										<>
											<EmptyTitle>{t("contactsEmptySectionTitle")}</EmptyTitle>
											<EmptyDescription>{t("contactsEmptySectionBody")}</EmptyDescription>
										</>
									)}
								</EmptyHeader>
							</Empty>
						</div>
					) : (
						<div className="flex-1 overflow-y-auto p-2">
							{sections.map(contactSection => (
								<section key={contactSection.key}>
									{/* Only "all" stacks more than one section at once — a single filtered section
								already names itself via the page's own <h1> above, so its inline header would be
								pure redundancy. */}
									{section === "all" ? (
										<h2 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
											{t(CONTACTS_SECTION_HEADER_KEY[contactSection.key])}
										</h2>
									) : null}
									<div className="flex flex-col gap-0.5">{renderSectionItems(contactSection)}</div>
								</section>
							))}
						</div>
					)}
				</div>
			</div>
			{renderActiveDialog()}
		</>
	)
}
