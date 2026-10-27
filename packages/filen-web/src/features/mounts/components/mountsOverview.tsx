import { useTranslation } from "react-i18next"
import { LayoutGridIcon } from "lucide-react"
import { desktopPlatform } from "@/lib/desktop"
import { LoadingState } from "@/components/loadingState"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { offeredProtocols } from "@/features/mounts/lib/mountsRoles"
import { useDriveControls } from "@/features/mounts/hooks/useDriveControls"
import { FuseCallout } from "@/features/mounts/components/fuseCallout"
import { DriveHero } from "@/features/mounts/components/driveHero"
import { ServeTile } from "@/features/mounts/components/serveHero"

// The platform never changes mid-session.
const PROTOCOLS = offeredProtocols(desktopPlatform())

// The bare /mounts: the network drive's card over a grid with one tile per server, each switchable in place through
// the same path as its own page. Everything is the overview the page already follows.
export function MountsOverview() {
	const { t } = useTranslation(["mounts", "common"])
	const controls = useDriveControls()

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/50 px-4">
				<LayoutGridIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<h1 className="truncate font-heading text-base font-medium tracking-tight">{t("common:moduleMounts")}</h1>
			</header>
			{controls === null ? (
				<LoadingState size="lg" />
			) : (
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-6 pb-12 sm:px-6">
					<div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
						<div className="flex flex-col gap-3">
							<DriveHero
								controls={controls}
								overview
							/>
							{controls.available ? null : <DesktopCallout tone="error">{t("unavailable")}</DesktopCallout>}
							<FuseCallout />
						</div>
						<section className="flex flex-col gap-2">
							<h2 className="px-5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
								{t("mountsServersHeading")}
							</h2>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
								{PROTOCOLS.map(protocol => (
									<ServeTile
										key={protocol}
										protocol={protocol}
									/>
								))}
							</div>
						</section>
					</div>
				</div>
			)}
		</>
	)
}
