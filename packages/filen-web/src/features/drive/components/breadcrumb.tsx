import { Fragment } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon } from "lucide-react"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { driveRouteIdFor, type DriveRouteId, splatToUuids } from "@/features/drive/lib/navigate"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { canDragVariant } from "@/features/drive/lib/dnd.logic"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

const VARIANT_ROOT_LABEL_KEY = {
	drive: "driveMyDrive",
	recents: "driveRecents",
	favorites: "driveFavorites",
	trash: "driveTrash",
	links: "driveLinks",
	sharedIn: "driveSharedIn",
	sharedOut: "driveSharedOut"
} as const satisfies Record<DriveVariant, string>

const CRUMB_LINK_CLASS = "text-muted-foreground hover:text-foreground hover:underline"
const CRUMB_CURRENT_CLASS = "font-medium text-foreground"

export interface BreadcrumbProps {
	variant: DriveVariant
	splat: string
}

interface CrumbLinkProps {
	variant: DriveVariant
	routeId: DriveRouteId
	// The link's splat param — "" for the root crumb, else the ancestor uuid chain.
	splatValue: string
	// Drop-target identity: null uuid + empty ancestry for the root crumb; else the segment's uuid and
	// its root-to-segment ancestry.
	targetUuid: string | null
	targetAncestry: readonly string[]
	label: string
}

// An ancestor breadcrumb crumb that doubles as a drag-to-move drop target (gated to the drive variant
// — its own component so the drop hook is called once per crumb, never in a loop). The current (last)
// segment stays a plain span, so it is never a target.
function CrumbLink({ variant, routeId, splatValue, targetUuid, targetAncestry, label }: CrumbLinkProps) {
	const drop = useDriveDropTarget({
		targetUuid,
		targetAncestry,
		disabled: !canDragVariant(variant)
	})

	return (
		<Link
			to={routeId}
			params={{ _splat: splatValue }}
			onDragEnter={drop.onDragEnter}
			onDragOver={drop.onDragOver}
			onDragLeave={drop.onDragLeave}
			onDrop={drop.onDrop}
			className={cn(
				CRUMB_LINK_CLASS,
				"rounded-sm px-1",
				drop.isOver && "bg-primary/10 text-foreground ring-2 ring-primary/60 ring-inset"
			)}
		>
			{label}
		</Link>
	)
}

// Root (an empty splat) renders its variant's own label directly — nothing to resolve, since the
// URL itself carries no ancestor uuids. A non-empty splat only ever occurs for the "drive" variant
// today (the only route with a "/drive/$" path — see routes/_app/drive.$.tsx), but the root label
// still keys off `variant` so a future nested route for another variant needs no change here.
export function Breadcrumb({ variant, splat }: BreadcrumbProps) {
	const { t } = useTranslation("drive")
	const rootLabel = t(VARIANT_ROOT_LABEL_KEY[variant])
	const uuids = splatToUuids(splat)
	// One route id for every crumb link — the shared variants link within their own splat routes, so
	// a breadcrumb ancestor click stays on "/shared-in/$" / "/shared-out/$" instead of jumping to the
	// owned "/drive/$" (see features/drive/lib/navigate.ts's driveRouteIdFor). All three routes take the same
	// splat param, so only the `to` differs.
	const routeId = driveRouteIdFor(variant)
	const namesQuery = useDirectoryNamesQuery(uuids)

	return (
		<nav aria-label={t("driveBreadcrumbLabel")}>
			<ol className="flex items-center gap-1.5 text-sm">
				<li>
					{uuids.length === 0 ? (
						<span
							aria-current="page"
							className={CRUMB_CURRENT_CLASS}
						>
							{rootLabel}
						</span>
					) : (
						<CrumbLink
							variant={variant}
							routeId={routeId}
							splatValue=""
							targetUuid={null}
							targetAncestry={[]}
							label={rootLabel}
						/>
					)}
				</li>

				{uuids.length > 0 && namesQuery.status === "pending" ? (
					<>
						<li aria-hidden>
							<ChevronRightIcon className="size-3.5 text-muted-foreground" />
						</li>
						{/* Spinner carries its own role="status"/aria-label — not aria-hidden, unlike the
						decorative chevrons, so assistive tech still hears the loading state. */}
						<li>
							<Spinner className="size-3.5 text-muted-foreground" />
						</li>
					</>
				) : null}

				{uuids.length > 0 && namesQuery.status === "error" ? (
					<>
						<li aria-hidden>
							<ChevronRightIcon className="size-3.5 text-muted-foreground" />
						</li>
						<li className="text-destructive">{errorLabel(asErrorDTO(namesQuery.error))}</li>
					</>
				) : null}

				{namesQuery.status === "success"
					? uuids.map((uuid, index) => {
							const isLast = index === uuids.length - 1
							// Whatever resolveDirectoryNames couldn't resolve for this one uuid (not found,
							// undecryptable meta) falls back to the raw uuid — a gap in an otherwise-resolved
							// path degrades one segment, never the whole breadcrumb.
							const label = namesQuery.data[uuid] ?? uuid

							return (
								<Fragment key={uuid}>
									<li aria-hidden>
										<ChevronRightIcon className="size-3.5 text-muted-foreground" />
									</li>
									<li>
										{isLast ? (
											<span
												aria-current="page"
												className={CRUMB_CURRENT_CLASS}
											>
												{label}
											</span>
										) : (
											<CrumbLink
												variant={variant}
												routeId={routeId}
												splatValue={uuids.slice(0, index + 1).join("/")}
												targetUuid={uuid}
												targetAncestry={uuids.slice(0, index + 1)}
												label={label}
											/>
										)}
									</li>
								</Fragment>
							)
						})
					: null}
			</ol>
		</nav>
	)
}
