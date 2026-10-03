import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Full-screen centred notice for the terminal/capability pages and the router's not-found page. Must
// stay free of SDK imports: /no-coi and /no-opfs render when the SDK never booted.
export function FullScreenNotice({
	icon,
	destructive,
	title,
	description,
	children
}: {
	icon: ReactNode
	destructive?: boolean
	title: ReactNode
	description?: ReactNode
	children: ReactNode
}) {
	// The first screen of a boot that never reaches the app: a capability page, the boot error or a 404.
	useDismissBootSplash()

	return (
		<div className="flex min-h-svh items-center justify-center bg-canvas p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia className={cn(destructive && "bg-destructive/10 text-destructive")}>{icon}</EmptyMedia>
					<EmptyTitle>{title}</EmptyTitle>
					{description ? <EmptyDescription>{description}</EmptyDescription> : null}
				</EmptyHeader>
				<EmptyContent>{children}</EmptyContent>
			</Empty>
		</div>
	)
}

export function ReloadButton() {
	const { t } = useTranslation()

	return (
		<Button
			onClick={() => {
				window.location.reload()
			}}
		>
			{t("reload")}
		</Button>
	)
}
