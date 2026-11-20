import { createFileRoute, redirect } from "@tanstack/react-router"
import { ContactsList } from "@/features/contacts/components/contactsList"
import { DEFAULT_CONTACTS_SECTION_FILTER, isContactsSectionFilter } from "@/features/contacts/components/contactsList.logic"

// One contacts section. A section this app does not have (a typo, a stale link) opens the default one.
export const Route = createFileRoute("/_app/contacts/$section")({
	beforeLoad: ({ params }) => {
		if (!isContactsSectionFilter(params.section)) {
			throw redirect({ to: "/contacts/$section", params: { section: DEFAULT_CONTACTS_SECTION_FILTER }, replace: true })
		}
	},
	component: ContactsSectionPage
})

function ContactsSectionPage() {
	const { section } = Route.useParams()

	return isContactsSectionFilter(section) ? <ContactsList section={section} /> : null
}
