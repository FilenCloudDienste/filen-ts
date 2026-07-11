import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { LayoutListIcon, InboxIcon, SendIcon, UsersIcon, BanIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
	CONTACTS_SECTION_FILTERS,
	CONTACTS_SECTION_HEADER_KEY,
	type ContactsSectionFilter
} from "@/features/contacts/components/contactsList.logic"
import { type ContactsKey } from "@/lib/i18n"

type IconType = ComponentType<{ className?: string }>

// One icon per filter — "all" gets its own (a stacked-list glyph, distinct from "contacts"'s people
// glyph so the two never read as the same entry at a glance); the other four reuse the exact section
// key the page itself already sections by (see contactsList.logic.ts's ContactSection).
const FILTER_ICON: Record<ContactsSectionFilter, IconType> = {
	all: LayoutListIcon,
	requests: InboxIcon,
	pending: SendIcon,
	contacts: UsersIcon,
	blocked: BanIcon
}

// "all" has no page-section header key of its own (it isn't a ContactSection — it means "every
// section, unfiltered", the page's original shape) — contactsSectionAll is its nav-only label.
const FILTER_LABEL_KEY: Record<ContactsSectionFilter, ContactsKey> = {
	all: "contactsSectionAll",
	...CONTACTS_SECTION_HEADER_KEY
}

// Same row styling idiom as DriveSidebar/NotesSidebar/ChatsSidebar/SettingsSidebar's own nav rows —
// each sidebar defines its own copy rather than sharing one (none of them export theirs either).
const NAV_ITEM_CLASS = cn(
	"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0",
	"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
	"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
)

// The shell's contacts contextual sidebar: a flat list of section-filter nav links, same w-52
// rounded-xl borderless panel geometry as the other module sidebars (SettingsSidebar's shape is the
// closest match — a flat single-level nav, no tree/search of its own). Every entry targets the same
// "/contacts" route with a different, always-explicit `section` search param (see
// routes/_app/contacts.tsx — deliberately no default-eliding middleware there, see its own doc
// comment) — TanStack stamps `data-status="active"`/`aria-current="page"` on the matching Link by
// comparing search params too (its default `includeSearch` behavior), so this needs no manual
// pathname/search comparison here, same as every sibling sidebar.
export function ContactsSidebar() {
	const { t } = useTranslation(["contacts", "common"])

	return (
		<aside
			// Drag region (Electron plumbing): inert in a plain browser, opted back out by every
			// interactive descendant via app-region-no-drag — same convention as the other sidebars.
			className="hidden w-52 shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
		>
			<div className="flex flex-1 flex-col overflow-y-auto p-3">
				<h2 className="truncate px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t("common:moduleContacts")}</h2>
				<div className="flex flex-col gap-0.5">
					{CONTACTS_SECTION_FILTERS.map(filter => {
						const Icon = FILTER_ICON[filter]

						return (
							<Link
								key={filter}
								to="/contacts"
								search={{ section: filter }}
								className={NAV_ITEM_CLASS}
							>
								<Icon className="text-muted-foreground group-data-[status=active]:text-primary" />
								<span className="truncate">{t(FILTER_LABEL_KEY[filter])}</span>
							</Link>
						)
					})}
				</div>
			</div>
		</aside>
	)
}
