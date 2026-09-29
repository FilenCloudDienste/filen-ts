import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, UsersIcon } from "lucide-react"
import type { UseQueryResult } from "@tanstack/react-query"
import type { ContactsQueryData } from "@/features/contacts/queries/contacts"
import { contactsNotIn, filterContactsBySearch } from "@/features/contacts/components/contactsList.logic"
import { ContactRow } from "@/features/contacts/components/contactRow"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { ListFilterInput } from "@/components/listFilterInput"
import { LoadingState } from "@/components/loadingState"
import { EmptyMessage, NoResultsMessage } from "@/components/emptyMessage"
import { SURFACE_RING } from "@/components/ui/surface"

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

// Filter box plus a fixed-height multi-select listbox of contacts. The caller owns the selection and
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
	const { t } = useTranslation("contacts")
	const contacts = contactsQuery.data?.contacts ?? []
	const candidates = exclude === undefined ? contacts : contactsNotIn(contacts, exclude)

	function renderBody(): ReactNode {
		if (contactsQuery.status === "pending") {
			return <LoadingState size="md" />
		}

		if (contactsQuery.status === "error") {
			return (
				<EmptyMessage
					icon={UsersIcon}
					title={t("contactsLoadError")}
					description={errorLabel(contactsQuery.error)}
				/>
			)
		}

		if (candidates.length === 0) {
			return (
				<EmptyMessage
					icon={UsersIcon}
					title={emptyTitle}
					description={emptyDescription}
				/>
			)
		}

		const filtered = filterContactsBySearch(candidates, filter)

		if (filtered.length === 0) {
			return <NoResultsMessage />
		}

		return (
			<div
				role="listbox"
				aria-multiselectable="true"
				aria-label={ariaLabel}
				className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2"
			>
				{filtered.map(contact => {
					const isSelected = selected.has(contact.uuid)

					return (
						<ContactRow
							key={contact.uuid}
							contact={contact}
							selected={isSelected}
							onToggleSelect={() => {
								onToggle(contact.uuid)
							}}
						>
							{isSelected ? (
								<CheckIcon
									aria-hidden="true"
									className="size-4 shrink-0 text-primary"
								/>
							) : null}
						</ContactRow>
					)
				})}
			</div>
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
			<div className={`flex h-72 flex-col overflow-hidden rounded-xl ${SURFACE_RING}`}>{renderBody()}</div>
		</>
	)
}
