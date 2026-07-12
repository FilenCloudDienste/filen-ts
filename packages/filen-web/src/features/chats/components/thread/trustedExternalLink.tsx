import { useState } from "react"
import { useTranslation } from "react-i18next"
import { externalLinkDomain, shouldInterceptLinkClick } from "@/features/chats/lib/linkTrust.logic"
import { trustDomain } from "@/features/chats/lib/trustedDomains"
import { useTrustedDomainsQuery } from "@/features/chats/queries/trustedDomains"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

// A message-text link anchor, gated by a one-time-per-domain trust confirmation before it's ever opened
// as a bare external navigation. Scoped to EXTERNAL (non-Filen) links only: a Filen public link
// resolves to null here (externalLinkDomain, linkTrust.logic.ts) and the caller (messageContent.tsx)
// renders a plain anchor for those instead — this component only ever mounts for a genuine external
// href. A domain already in the persisted trust set opens immediately on click, same as a plain anchor
// would; an unconfirmed domain intercepts the click, shows the confirmation, and persists the domain
// (trustDomain) only once the user actually confirms — declining leaves the domain untrusted for next
// time too.
export function TrustedExternalLink({ href, className }: { href: string; className?: string }) {
	const { t } = useTranslation(["chats", "common"])
	const trustedQuery = useTrustedDomainsQuery()
	const domain = externalLinkDomain(href)
	const [pendingConfirm, setPendingConfirm] = useState(false)

	// No stable domain to gate on (an unparseable href — see externalLinkDomain's own doc comment on why
	// this is effectively unreachable given hardenLinkHref's upstream http(s)-only filter) — render a
	// plain, ungated anchor rather than block navigation on a confirmation that could never resolve.
	if (domain === null) {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				className={className}
			>
				{href}
			</a>
		)
	}

	// Rebound so the nested closures below capture a definitely-`string` value — TS's control-flow
	// narrowing from the early return above doesn't extend into a function body defined later, even for
	// an unreassigned `const`.
	const gatedDomain: string = domain

	function handleClick(event: React.MouseEvent<HTMLAnchorElement>): void {
		if (!shouldInterceptLinkClick(gatedDomain, trustedQuery.data ?? new Set())) {
			return
		}

		event.preventDefault()
		setPendingConfirm(true)
	}

	// window.open runs FIRST and synchronously, still inside the dialog button's own click handler — a
	// browser's popup blocker only honors window.open as a direct continuation of user activation, and
	// that activation does not survive an `await` (verified browser behavior); persisting the trust
	// decision (which does need to await the kv write) happens AFTER, never gating the navigation on it.
	function handleConfirm(): void {
		window.open(href, "_blank", "noopener,noreferrer")
		setPendingConfirm(false)

		void trustDomain(gatedDomain).then(() => trustedQuery.refetch())
	}

	return (
		<>
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				className={className}
				onClick={handleClick}
			>
				{href}
			</a>
			<ConfirmDialog
				open={pendingConfirm}
				pending={false}
				title={t("chatLinkTrustTitle")}
				body={t("chatLinkTrustBody", { domain })}
				confirmLabel={t("chatLinkTrustConfirm")}
				cancelLabel={t("common:cancel")}
				onOpenChange={open => {
					if (!open) {
						setPendingConfirm(false)
					}
				}}
				onConfirm={handleConfirm}
			/>
		</>
	)
}
