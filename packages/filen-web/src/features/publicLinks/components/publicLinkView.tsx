import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { resolveRouteLink, type PublicLinkKind } from "@/features/publicLinks/lib/format.logic"
import { publicLinkState, type PublicLinkState } from "@/features/publicLinks/lib/state.logic"
import { usePublicLinkResource } from "@/features/publicLinks/queries/publicLink"
import { Logo } from "@/features/shell/components/logo"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

// The UNAUTHENTICATED public-link viewer — foundation cut. Rendered by both /f/ (file) and /d/ (dir),
// gated ONLY by the root BootGate (no auth redirect either way), so an anonymous visitor and a
// signed-in visitor both land here. Pure presentation over the data path: resolveRouteLink (uuid from
// the path param, key from the URL fragment — the key never leaves the fragment) → usePublicLinkResource
// (anon worker surface) → publicLinkState. The next step swaps this minimal surface for the real
// browse/preview/download/password UI without touching that data path.
export function PublicLinkView({ kind, uuid }: { kind: PublicLinkKind; uuid: string }) {
	// The fragment carries the decryption key and is client-side only; read it straight off the live
	// location (it is fixed for the lifetime of a mounted view — a different link is a fresh navigation).
	const hash = typeof window === "undefined" ? "" : window.location.hash
	const resolved = resolveRouteLink(uuid, hash)
	const query = usePublicLinkResource(kind, resolved?.uuid ?? null, resolved?.key ?? null)

	const state: PublicLinkState =
		resolved === null ? { status: "invalid" } : publicLinkState({ status: query.status, data: query.data, error: query.error })

	return <PublicLinkSurface state={state} />
}

function PublicLinkSurface({ state }: { state: PublicLinkState }) {
	const { t } = useTranslation("publicLinks")

	return (
		<div className="flex min-h-svh items-center justify-center bg-canvas p-6 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<Logo className="size-10 text-primary" />
					<PublicLinkCardHeader state={state} />
				</CardHeader>
				{state.status !== "loading" && (
					<CardContent className="justify-items-center text-center">
						<Link
							to="/"
							className="text-sm text-foreground underline underline-offset-4"
						>
							{t("back")}
						</Link>
					</CardContent>
				)}
			</Card>
		</div>
	)
}

function PublicLinkCardHeader({ state }: { state: PublicLinkState }) {
	const { t } = useTranslation("publicLinks")

	if (state.status === "loading") {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner />
				<span>{t("opening")}</span>
			</div>
		)
	}

	if (state.status === "invalid") {
		return (
			<div className="flex flex-col gap-1">
				<CardTitle>{t("unavailableTitle")}</CardTitle>
				<CardDescription>{t("unavailableBody")}</CardDescription>
			</div>
		)
	}

	if (state.status === "password") {
		return (
			<div className="flex flex-col gap-1">
				<CardTitle>{t("passwordTitle")}</CardTitle>
				<CardDescription>{t("passwordBody")}</CardDescription>
			</div>
		)
	}

	const resource = state.resource

	return (
		<div className="flex flex-col gap-1">
			<CardTitle className="break-all">{resource.name}</CardTitle>
			<CardDescription>
				{resource.kind === "file" ? `${t("fileLabel")} · ${formatBytes(Number(resource.size))}` : t("directoryLabel")}
			</CardDescription>
		</div>
	)
}
