import { type ReactNode } from "react"
import { AddContactDialog } from "@/features/contacts/components/addContactDialog"
import { useTranslation } from "react-i18next"
import { UsersIcon } from "lucide-react"
import type { UseQueryResult } from "@tanstack/react-query"
import type { ContactsQueryData } from "@/features/contacts/queries/contacts"
import { contactsNotIn, filterContactsBySearch, sortContactsByDisplayName } from "@/features/contacts/components/contactsList.logic"
import { ContactPickerRows } from "@/features/contacts/components/contactPickerRows"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { blockingQueryError } from "@/queries/blockingError"
import { Button } from "@/components/ui/button"
import { ListFilterInput } from "@/components/listFilterInput"
import { LoadingState } from "@/components/loadingState"
import { EmptyMessage, NoResultsMessage } from "@/components/emptyMessage"
import { SURFACE_RING } from "@/components/ui/surface"
import { LIST_DIALOG_BODY_CLASS } from "@/components/dialogs/listDialog"

export interface ContactPickerListProps {
	contactsQuery: UseQueryResult<ContactsQueryData>
	filter: string
	onFilterChange: (value: string) => void
	selected: ReadonlySet<string>
	onToggle: (uuid: string) => void
	ariaLabel: string
	// Shown when there is no contact to pick at all (before any filtering).
	emptyTitle: string
	emptyDescription?: string | undefined
	// Users already in the target (a chat's or note's participants), left out of the candidates.
	exclude?: readonly { userId: bigint }[] | undefined
}

// Filter box plus a multi-select listbox of contacts in name order, filling a LIST_DIALOG_CLASS dialog. The caller owns the selection and
// filter state; a filter never touches the selection, so a picked row stays picked once filtered out.
export function ContactPickerList({
	contactsQuery,
	filter,
	onFilterChange,
	selected,
	onToggle,
	ariaLabel,
	emptyTitle,
	emptyDescription,
	exclude
}: ContactPickerListProps) {
	const { t } = useTranslation(["contacts", "common"])
	const contacts = contactsQuery.data?.contacts ?? []
	const candidates = sortContactsByDisplayName(exclude === undefined ? contacts : contactsNotIn(contacts, exclude))

	function renderBody(): ReactNode {
		if (contactsQuery.status === "pending") {
			return <LoadingState size="md" />
		}

		// A failed background refetch keeps the already loaded contacts up.
		const queryError = blockingQueryError(contactsQuery)

		if (queryError !== null) {
			return (
				<EmptyMessage
					icon={UsersIcon}
					title={t("contactsLoadError")}
					description={errorLabel(queryError)}
				>
					<Button
						variant="outline"
						onClick={() => {
							void contactsQuery.refetch()
						}}
					>
						{t("common:tryAgain")}
					</Button>
				</EmptyMessage>
			)
		}

		if (candidates.length === 0) {
			return (
				<EmptyMessage
					icon={UsersIcon}
					title={emptyTitle}
					description={emptyDescription}
				>
					<AddContactDialog />
				</EmptyMessage>
			)
		}

		const filtered = filterContactsBySearch(candidates, filter)

		if (filtered.length === 0) {
			return <NoResultsMessage />
		}

		return (
			<ContactPickerRows
				contacts={filtered}
				selected={selected}
				onToggle={onToggle}
				ariaLabel={ariaLabel}
			/>
		)
	}

	return (
		<>
			{candidates.length > 0 ? (
				<ListFilterInput
					value={filter}
					onChange={onFilterChange}
					placeholder={t("contactsSearchPlaceholder")}
					ariaLabel={t("contactsSearchPlaceholder")}
				/>
			) : null}
			<div className={`flex flex-col overflow-hidden rounded-xl ${SURFACE_RING} ${LIST_DIALOG_BODY_CLASS}`}>{renderBody()}</div>
		</>
	)
}
