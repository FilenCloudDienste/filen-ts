import { useCallback } from "react"
import { Linking } from "react-native"
import { useTranslation } from "react-i18next"
import { useSecureStore } from "@/lib/secureStore"
import { safeParseUrl } from "@/lib/linkParser"
import { classifyExternalLinkHref } from "@/components/textEditor/linkUtils"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import { run } from "@filen/utils"

export const OPEN_LINK_TRUSTED_DOMAINS_SECURE_STORE_KEY = "openLinkTrustedDomains"

/**
 * Open a link that came from content the user did not author — a previewed document, a shared note,
 * a message — through ONE policy.
 *
 * This is deliberately the single funnel for every untrusted link in the app. Before this existed the
 * same threat model was handled three different ways: a .docx link opened with no confirmation, the
 * identical link in a PDF was refused outright, and the rich-text toolbar opened whatever the WebView
 * handed it. "Defensible per call site" added up to something incoherent, so the decision lives here
 * now and callers just supply the URL.
 *
 * The policy:
 *  1. Scheme allowlist (`classifyExternalLinkHref`) — http/https plus the user-navigable
 *     communication schemes. `javascript:`, `data:`, `file:`, `content:` and `intent:` are refused.
 *  2. For http(s) only, `safeParseUrl` additionally requires https and rejects embedded credentials
 *     and private/loopback hosts, then the host is shown in a trusted-domain confirmation remembered
 *     per domain. A communication scheme has no host to vet or display, so it skips this step — the
 *     allowlist plus the OS's own handler UI is the check there.
 *  3. `canOpenURL`, so a scheme with no installed handler reports cleanly instead of throwing.
 *
 * Callers pass a `tag` purely for log attribution.
 */
export default function useOpenExternalLink(tag: string): (rawUrl: string) => Promise<void> {
	const { t } = useTranslation()
	const [trustedDomains, setTrustedDomains] = useSecureStore<Record<string, boolean>>(
		OPEN_LINK_TRUSTED_DOMAINS_SECURE_STORE_KEY,
		{}
	)

	return useCallback(
		async (rawUrl: string) => {
			const classification = classifyExternalLinkHref(rawUrl)

			if (!classification.intercept) {
				logger.warn(tag, "refused to open a link with a non-allowlisted scheme")
				alerts.error(t("cannot_open_link"))

				return
			}

			const isWebLink = /^https?:\/\//i.test(classification.url)

			// A web link is the only kind with a host worth vetting and showing. safeParseUrl also
			// pins it to https — an http:// link from an untrusted document is not worth opening in
			// cleartext, and this matches how chat already treats message links.
			const url = isWebLink ? safeParseUrl(classification.url) : null

			if (isWebLink && !url) {
				logger.warn(tag, "refused to open a web link that failed URL validation")
				alerts.error(t("cannot_open_link"))

				return
			}

			const href = url ? url.href : classification.url

			const canOpenResult = await run(async () => {
				return await Linking.canOpenURL(href)
			})

			if (!canOpenResult.success) {
				logger.error(tag, "canOpenURL failed for external link", { error: canOpenResult.error })
				alerts.error(canOpenResult.error)

				return
			}

			if (!canOpenResult.data) {
				alerts.error(t("cannot_open_link"))

				return
			}

			// No host to confirm (mailto:/tel:/sms:/…) — the OS presents its own compose/dial UI, which
			// is the confirmation for those.
			if (!url) {
				const directResult = await run(async () => {
					return await Linking.openURL(href)
				})

				if (!directResult.success) {
					logger.error(tag, "openURL failed for external link", { error: directResult.error })
					alerts.error(directResult.error)
				}

				return
			}

			const domain = url.hostname

			if (!trustedDomains[domain]) {
				const promptResponse = await run(async () => {
					return await prompts.alert({
						title: t("open_external_link"),
						message: t("open_external_link_message", {
							domain
						}),
						cancelText: t("cancel"),
						okText: t("open_trust")
					})
				})

				if (!promptResponse.success) {
					logger.error(tag, "trust-prompt failed", { error: promptResponse.error })
					alerts.error(promptResponse.error)

					return
				}

				if (promptResponse.data.cancelled) {
					return
				}

				setTrustedDomains(prev => ({
					...prev,
					[domain]: true
				}))
			}

			const openResult = await run(async () => {
				return await Linking.openURL(href)
			})

			if (!openResult.success) {
				logger.error(tag, "openURL failed for external link", { error: openResult.error })
				alerts.error(openResult.error)
			}
		},
		[t, tag, trustedDomains, setTrustedDomains]
	)
}
