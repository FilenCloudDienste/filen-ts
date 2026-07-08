import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { SearchIcon, UsersIcon } from "lucide-react"
import { useContactsQuery, useContactRequestsQuery } from "@/queries/contacts"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type ContactsKey } from "@/lib/i18n"
import { buildContactSections, type ContactSection } from "@/components/contacts/contacts-list.logic"
import { ContactRow, ContactRequestRow, BlockedContactRow } from "@/components/contacts/contact-row"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

const SECTION_HEADER_KEY: Record<ContactSection["key"], ContactsKey> = {
	requests: "contactsSectionRequests",
	pending: "contactsSectionPending",
	contacts: "contactsSectionContacts",
	blocked: "contactsSectionBlocked"
}

const SKELETON_ROW_COUNT = 6

// One row per section item, dispatched on the section's own key — the key already discriminates
// `items`' concrete type (see contacts-list.logic.ts's ContactSection), so no per-item type tag is
// needed the way mobile's flat single-list rendering requires one. The trailing action slot on every
// row renders nothing yet.
function renderSectionItems(section: ContactSection): ReactNode {
	switch (section.key) {
		case "requests":
			return section.items.map(request => (
				<ContactRequestRow
					key={request.uuid}
					request={request}
				/>
			))
		case "pending":
			return section.items.map(request => (
				<ContactRequestRow
					key={request.uuid}
					request={request}
				/>
			))
		case "contacts":
			return section.items.map(contact => (
				<ContactRow
					key={contact.uuid}
					contact={contact}
				/>
			))
		case "blocked":
			return section.items.map(blocked => (
				<BlockedContactRow
					key={blocked.uuid}
					contact={blocked}
				/>
			))
	}
}

// Owns both contacts queries, the search box's local state, and the whole status-branch (loading
// skeleton / load-error / empty / sectioned list) — mirrors DirectoryListing's own self-contained
// shape (route files stay thin; the content component owns its data). The add-contact trigger and
// every per-row action are a later task's concern — this renders the list, the rows, and search only.
export function ContactsList() {
	const { t } = useTranslation(["contacts", "common"])
	const [search, setSearch] = useState("")
	const contactsQuery = useContactsQuery()
	const requestsQuery = useContactRequestsQuery()

	const isPending = contactsQuery.status === "pending" || requestsQuery.status === "pending"
	// At most one of these can be an actual Error at a time in practice, but either query can fail
	// independently — check contacts first, requests second; a retry always refetches both regardless
	// of which one is shown, so which one "wins" the display only affects the error copy.
	const queryError =
		contactsQuery.status === "error" ? contactsQuery.error : requestsQuery.status === "error" ? requestsQuery.error : null

	const sections = buildContactSections({
		contacts: contactsQuery.data?.contacts ?? [],
		blocked: contactsQuery.data?.blocked ?? [],
		incoming: requestsQuery.data?.incoming ?? [],
		outgoing: requestsQuery.data?.outgoing ?? [],
		search
	})

	function handleRetry(): void {
		void contactsQuery.refetch()
		void requestsQuery.refetch()
	}

	return (
		<>
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<h1 className="text-sm font-medium">{t("common:moduleContacts")}</h1>
			</header>
			<div className="flex h-12 shrink-0 items-center border-b border-border px-4">
				<div className="relative w-full max-w-xs">
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
					<div className="flex flex-1 overflow-y-auto">
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<UsersIcon />
								</EmptyMedia>
								<EmptyTitle>{t("contactsEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("contactsEmptyBody")}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					<div className="flex-1 overflow-y-auto p-2">
						{sections.map(section => (
							<section key={section.key}>
								<h2 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
									{t(SECTION_HEADER_KEY[section.key])}
								</h2>
								<div className="flex flex-col gap-0.5">{renderSectionItems(section)}</div>
							</section>
						))}
					</div>
				)}
			</div>
		</>
	)
}
