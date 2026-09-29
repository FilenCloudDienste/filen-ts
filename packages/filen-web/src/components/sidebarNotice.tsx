import type { ReactNode } from "react"

// Compact centered empty/error state, sized for the narrow sidebar (not the full-page Empty primitive).
// `role` is opt-in so only a load-failure caller announces — an empty list is not an error.
export function SidebarNotice({
	icon,
	title,
	description,
	action,
	role
}: {
	icon: ReactNode
	title: string
	description?: string
	action?: ReactNode
	role?: "alert"
}) {
	return (
		<div
			role={role}
			className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
		>
			<div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
			<p className="text-sm font-medium">{title}</p>
			{description !== undefined ? <p className="text-xs text-muted-foreground">{description}</p> : null}
			{action}
		</div>
	)
}
