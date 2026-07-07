import { Fragment } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon } from "lucide-react"
import { type DriveVariant } from "@/lib/drive/preferences"
import { splatToUuids } from "@/lib/drive/navigate"
import { useDirectoryNamesQuery } from "@/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { Spinner } from "@/components/ui/spinner"

const VARIANT_ROOT_LABEL_KEY = {
	drive: "driveMyDrive",
	recents: "driveRecents",
	favorites: "driveFavorites",
	trash: "driveTrash"
} as const satisfies Record<DriveVariant, string>

const CRUMB_LINK_CLASS = "text-muted-foreground hover:text-foreground hover:underline"
const CRUMB_CURRENT_CLASS = "font-medium text-foreground"

export interface BreadcrumbProps {
	variant: DriveVariant
	splat: string
}

// Root (an empty splat) renders its variant's own label directly — nothing to resolve, since the
// URL itself carries no ancestor uuids. A non-empty splat only ever occurs for the "drive" variant
// today (the only route with a "/drive/$" path — see routes/_app/drive.$.tsx), but the root label
// still keys off `variant` so a future nested route for another variant needs no change here.
export function Breadcrumb({ variant, splat }: BreadcrumbProps) {
	const { t } = useTranslation("drive")
	const rootLabel = t(VARIANT_ROOT_LABEL_KEY[variant])
	const uuids = splatToUuids(splat)
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
						<Link
							to="/drive/$"
							params={{ _splat: "" }}
							className={CRUMB_LINK_CLASS}
						>
							{rootLabel}
						</Link>
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
											<Link
												to="/drive/$"
												params={{ _splat: uuids.slice(0, index + 1).join("/") }}
												className={CRUMB_LINK_CLASS}
											>
												{label}
											</Link>
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
