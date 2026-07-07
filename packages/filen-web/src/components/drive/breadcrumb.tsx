import { Fragment } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon } from "lucide-react"
import { type DriveVariant } from "@/lib/drive/preferences"
import { useDirectoryPathQuery } from "@/queries/drive"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { Spinner } from "@/components/ui/spinner"

const VARIANT_ROOT_LABEL_KEY = {
	drive: "driveMyDrive",
	recents: "driveRecents",
	favorites: "driveFavorites",
	trash: "driveTrash"
} as const satisfies Record<DriveVariant, string>

export interface BreadcrumbProps {
	variant: DriveVariant
	uuid: string | null
}

// Root (uuid === null) renders its variant's own label directly — no ancestors exist to fetch
// (Root is not a valid getItemPath argument). A non-null uuid only ever occurs for the "drive"
// variant today (the only route with a $uuid segment — see routes/_app/drive_.$uuid.tsx), but the
// root label still keys off `variant` so a future nested route for another variant needs no change
// here.
export function Breadcrumb({ variant, uuid }: BreadcrumbProps) {
	const { t } = useTranslation("drive")
	const rootLabel = t(VARIANT_ROOT_LABEL_KEY[variant])
	const pathQuery = useDirectoryPathQuery(uuid)

	return (
		<nav aria-label={t("driveBreadcrumbLabel")}>
			<ol className="flex items-center gap-1.5 text-sm">
				<li>
					{uuid === null ? (
						<span
							aria-current="page"
							className="font-medium text-foreground"
						>
							{rootLabel}
						</span>
					) : (
						<Link
							to="/drive"
							className="text-muted-foreground hover:text-foreground hover:underline"
						>
							{rootLabel}
						</Link>
					)}
				</li>

				{uuid !== null && pathQuery.status === "pending" ? (
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

				{uuid !== null && pathQuery.status === "error" ? (
					<>
						<li aria-hidden>
							<ChevronRightIcon className="size-3.5 text-muted-foreground" />
						</li>
						<li className="text-destructive">{errorLabel(asErrorDTO(pathQuery.error))}</li>
					</>
				) : null}

				{uuid !== null && pathQuery.status === "success"
					? pathQuery.data.ancestors.map(ancestor => (
							<Fragment key={ancestor.data.uuid}>
								<li aria-hidden>
									<ChevronRightIcon className="size-3.5 text-muted-foreground" />
								</li>
								<li>
									<Link
										to="/drive/$uuid"
										params={{ uuid: ancestor.data.uuid }}
										className="text-muted-foreground hover:text-foreground hover:underline"
									>
										{ancestor.data.decryptedMeta?.name ?? ancestor.data.uuid}
									</Link>
								</li>
							</Fragment>
						))
					: null}

				{uuid !== null && pathQuery.status === "success" ? (
					<>
						<li aria-hidden>
							<ChevronRightIcon className="size-3.5 text-muted-foreground" />
						</li>
						<li
							aria-current="page"
							className="font-medium text-foreground"
						>
							{pathQuery.data.current.data.decryptedMeta?.name ?? pathQuery.data.current.data.uuid}
						</li>
					</>
				) : null}
			</ol>
		</nav>
	)
}
