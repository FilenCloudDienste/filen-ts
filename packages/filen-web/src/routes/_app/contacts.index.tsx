import { createFileRoute, redirect } from "@tanstack/react-router"
import { DEFAULT_CONTACTS_SECTION_FILTER } from "@/features/contacts/components/contactsList.logic"

// Bare /contacts (and an old `?section=` this did not rewrite, lib/legacyUrl.logic.ts) opens the default section.
export const Route = createFileRoute("/_app/contacts/")({
	beforeLoad: () => {
		throw redirect({ to: "/contacts/$section", params: { section: DEFAULT_CONTACTS_SECTION_FILTER }, replace: true })
	}
})
