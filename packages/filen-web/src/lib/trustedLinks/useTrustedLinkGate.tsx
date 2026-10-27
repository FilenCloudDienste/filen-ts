import { useState, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { externalLinkDomain, shouldInterceptLinkClick } from "@/lib/trustedLinks/linkTrust.logic"
import { trustDomain } from "@/lib/trustedLinks/trustedDomains"
import { useTrustedDomainsQuery } from "@/lib/trustedLinks/trustedDomainsQuery"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

export interface TrustedLinkGate {
	// True when `href` leads to a domain not trusted yet: the confirmation is shown and the caller must not
	// open the link itself. False when it may open now (a trusted domain, a Filen link, no host to confirm).
	intercept: (href: string) => boolean
	// Delegated click and middle-click handlers for a container of anchors that open in a new tab: the
	// anchor's own navigation goes ahead unless intercept asks first.
	onClick: (event: MouseEvent<HTMLElement>) => void
	onAuxClick: (event: MouseEvent<HTMLElement>) => void
	// The confirmation, rendered by the caller.
	dialog: ReactNode
	// The confirmation is open; cancel() closes it without opening the link (its surface went away).
	readonly pending: boolean
	cancel: () => void
}

// The one-time-per-domain confirmation before an external link opens (chat messages, documents, markdown,
// PDF): one persisted trust set, so a domain confirmed anywhere is trusted everywhere. On confirm the link
// opens first and synchronously, inside the button's user activation (a popup blocker honours window.open
// only there, and activation does not survive an await); the trust write follows.
export function useTrustedLinkGate(): TrustedLinkGate {
	const { t } = useTranslation("common")
	const trustedQuery = useTrustedDomainsQuery()
	const [pending, setPending] = useState<{ href: string; domain: string } | null>(null)

	const intercept = (href: string): boolean => {
		const domain = externalLinkDomain(href)

		if (domain === null || !shouldInterceptLinkClick(domain, trustedQuery.data ?? new Set())) {
			return false
		}

		setPending({ href, domain })

		return true
	}

	const onClick = (event: MouseEvent<HTMLElement>): void => {
		const anchor = event.target instanceof Element ? event.target.closest("a[target='_blank'][href]") : null
		const href = anchor?.getAttribute("href")

		if (href !== null && href !== undefined && intercept(href)) {
			event.preventDefault()
		}
	}

	const dialog = (
		<ConfirmDialog
			open={pending !== null}
			pending={false}
			title={t("linkTrustTitle")}
			body={t("linkTrustBody", { domain: pending?.domain ?? "" })}
			confirmLabel={t("linkTrustConfirm")}
			cancelLabel={t("cancel")}
			onOpenChange={open => {
				if (!open) {
					setPending(null)
				}
			}}
			onConfirm={() => {
				if (pending === null) {
					return
				}

				window.open(pending.href, "_blank", "noopener,noreferrer")
				setPending(null)

				void trustDomain(pending.domain).then(() => trustedQuery.refetch())
			}}
		/>
	)

	return {
		intercept,
		onClick,
		onAuxClick: event => {
			// A middle-click opens a link too (in a new tab, without a click event).
			if (event.button === 1) {
				onClick(event)
			}
		},
		dialog,
		pending: pending !== null,
		cancel: () => {
			setPending(null)
		}
	}
}
