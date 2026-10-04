import { useTranslation } from "react-i18next"
import type { Contact } from "@filen/sdk-rs"
import { contactDisplayName } from "@filen/shared"
import { accountQueryGet } from "@/queries/account"
import { cachedDirectoryNames } from "@/features/drive/queries/drive"
import { useContactsQuery } from "@/features/contacts/queries/contacts"
import type { EventContact, EventModelContext } from "@/features/settings/lib/eventModel"

// The event model's lookups over what the caches already hold. Each index is built once, on its first
// lookup, so a context no row asks a name of costs nothing.
export function createEventModelContext({
	t,
	contacts
}: {
	t: EventModelContext["t"]
	contacts: readonly Contact[] | undefined
}): EventModelContext {
	let directoryNames: Map<string, string> | undefined
	let contactsByEmail: Map<string, EventContact> | undefined

	return {
		t,
		rootUuid: accountQueryGet()?.rootDirUuid,
		directoryName: uuid => {
			directoryNames ??= cachedDirectoryNames()

			return directoryNames.get(uuid)
		},
		contact: email => {
			if (contactsByEmail === undefined) {
				contactsByEmail = new Map()

				for (const contact of contacts ?? []) {
					contactsByEmail.set(
						contact.email.toLowerCase(),
						contact.avatar === undefined
							? { name: contactDisplayName(contact) }
							: { name: contactDisplayName(contact), avatar: contact.avatar }
					)
				}
			}

			return contactsByEmail.get(email.toLowerCase())
		}
	}
}

// Reads the contacts cache without fetching it, so contacts loaded meanwhile show up; directory names
// are read from the listings once per context.
export function useEventModelContext(): EventModelContext {
	const { t } = useTranslation(["events", "drive"])
	const contacts = useContactsQuery({ enabled: false }).data?.contacts

	return createEventModelContext({ t, contacts })
}
