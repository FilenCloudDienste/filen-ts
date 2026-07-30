import { useEffect, useRef, useState } from "react"
import { ActivityIndicator } from "react-native"
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import { run } from "@filen/utils"
import Dom from "@/components/pdfPreview/dom"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import View from "@/components/ui/view"
import { parsePdfExternalLink, parsePdfViewerEvent, type PdfPasswordResponse } from "@/components/pdfPreview/protocol"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import type { WebViewMessageEvent } from "react-native-webview"

type Phase = "loading" | "ready" | "unsupported" | "error" | "passwordCancelled"

// How long to wait for the viewer to announce itself before deciding the WebView is not going to
// boot. Generous, because it covers bundle parse on a cold, slow device — but finite, because the
// alternative is an opaque overlay with nothing behind it and no way out.
const BOOT_TIMEOUT_MS = 20000

/**
 * Native half of the PDF viewer.
 *
 * Owns the message boundary: every payload the WebView sends is re-parsed and re-validated here
 * before anything acts on it, and the only thing that ever reaches the OS is a URL that has been
 * classified a second time on this side and then passed through the app-wide link funnel.
 *
 * Renderer death is handled explicitly rather than left to the default, which silently reloads —
 * a reload restarts the document from nothing and, if whatever killed the renderer is deterministic,
 * loops. One retry, then a refusal the user can act on.
 */
const PdfPreview = ({
	readRange,
	fileSize,
	paddingTop,
	paddingBottom,
	paddingLeft,
	paddingRight
}: {
	readRange: (offset: number, length: number) => Promise<string>
	fileSize: number
	paddingTop?: number
	paddingBottom?: number
	paddingLeft?: number
	paddingRight?: number
}) => {
	const { t } = useTranslation()
	const openExternalLink = useOpenExternalLink("pdfPreview")
	const [phase, setPhase] = useState<Phase>("loading")
	const [passwordResponse, setPasswordResponse] = useState<PdfPasswordResponse | null>(null)
	const promptingRef = useRef<boolean>(false)
	const lastRequestIdRef = useRef<string | null>(null)

	// The viewer posts `ready` once its bundle has evaluated and its capability checks have passed. If
	// that never arrives, nothing else will either — no document, no error — so the overlay would stay
	// up forever. Cleared as soon as any phase other than loading is reached.
	useEffect(() => {
		if (phase !== "loading") {
			return
		}

		const timeout = setTimeout(() => {
			logger.error("pdfPreview", "the viewer did not report ready in time")

			setPhase("error")
		}, BOOT_TIMEOUT_MS)

		return () => {
			clearTimeout(timeout)
		}
	}, [phase])

	const promptForPassword = async (requestId: string, incorrect: boolean) => {
		if (promptingRef.current) {
			return
		}

		promptingRef.current = true

		const result = await run(async () => {
			return await prompts.input({
				title: t("password_required"),
				message: incorrect ? t("incorrect_pdf_password") : t("enter_the_password"),
				cancelText: t("cancel"),
				okText: t("ok"),
				inputType: "secure-text"
			})
		})

		promptingRef.current = false

		if (!result.success) {
			logger.error("pdfPreview", "password prompt failed", {
				error: result.error
			})

			setPhase("error")

			return
		}

		if (result.data.cancelled || result.data.type !== "string" || result.data.value.length === 0) {
			// Not an error: the user declined to answer. The old viewer offered a way back in and this
			// keeps that, because otherwise the only recovery from a mistyped tap is closing the preview.
			setPhase("passwordCancelled")

			return
		}

		setPasswordResponse({
			requestId,
			password: result.data.value
		})
	}

	return (
		<View className="flex-1 bg-background">
			<Dom
				readRange={readRange}
				fileSize={fileSize}
				passwordResponse={passwordResponse}
				paddingTop={paddingTop}
				paddingBottom={paddingBottom}
				paddingLeft={paddingLeft}
				paddingRight={paddingRight}
				dom={{
					overScrollMode: "never",
					bounces: false,
					// Overrides Expo's defaults, which reload the WebView when its renderer dies. A reload
					// restarts the document from nothing, and whatever killed the renderer — an enormous
					// page, a pathological image — is usually deterministic, so it would loop. Refuse
					// instead, with no automatic retry: the user can reopen the preview.
					onContentProcessDidTerminate: () => {
						logger.warn("pdfPreview", "the webview renderer terminated")

						setPhase("error")
					},
					onRenderProcessGone: () => {
						logger.warn("pdfPreview", "the webview renderer was killed")

						setPhase("error")
					},
					onMessage: (event: WebViewMessageEvent) => {
						try {
							const parsed: unknown = JSON.parse(event.nativeEvent.data)

							if (forwardDomConsoleLog(parsed)) {
								return
							}

							const externalUrl = parsePdfExternalLink(parsed)

							if (externalUrl !== null) {
								openExternalLink(externalUrl).catch(err => {
									logger.error("pdfPreview", "failed to open a document link", {
										error: err
									})
								})

								return
							}

							const viewerEvent = parsePdfViewerEvent(parsed)

							if (viewerEvent === null) {
								return
							}

							switch (viewerEvent.event) {
								case "unsupported": {
									logger.warn("pdfPreview", "the webview cannot run the viewer", {
										reason: viewerEvent.reason
									})

									setPhase("unsupported")

									break
								}

								case "firstPagePainted": {
									// Consumed — the password must not linger in props any longer than the
									// load that needed it.
									setPasswordResponse(null)
									setPhase("ready")

									break
								}

								case "ready": {
									// Boot handshake: the WebView is alive. The document may still fail, but a
									// failure now arrives as an event rather than as silence.
									break
								}

								case "passwordRequired": {
									setPasswordResponse(null)

									lastRequestIdRef.current = viewerEvent.requestId

									promptForPassword(viewerEvent.requestId, viewerEvent.reason === "incorrect").catch(err => {
										logger.error("pdfPreview", "password flow failed", {
											error: err
										})

										alerts.error(err)
									})

									break
								}

								case "error": {
									logger.error("pdfPreview", "the viewer reported a failure", {
										kind: viewerEvent.kind
									})

									// Only take over the screen if nothing has painted. Once pages are visible, a
									// later failure — a range read past the cumulative budget, one page that would
									// not decode — must not replace a document the user is reading with a
									// full-screen error.
									setPhase(current => (current === "ready" ? current : "error"))

									break
								}
							}
						} catch {
							// ignore malformed messages
						}
					}
				}}
			/>
			{phase !== "ready" && (
				<View className="absolute inset-0 items-center justify-center bg-background px-8">
					{phase === "loading" ? (
						<ActivityIndicator
							size="small"
							color="white"
						/>
					) : phase === "passwordCancelled" ? (
						<PressableScale
							onPress={() => {
								const requestId = lastRequestIdRef.current

								if (requestId === null) {
									return
								}

								setPhase("loading")

								promptForPassword(requestId, false).catch(err => {
									logger.error("pdfPreview", "password retry failed", {
										error: err
									})
								})
							}}
							hitSlop={10}
						>
							<Text className="text-sm leading-5 text-primary">{t("enter_pdf_password")}</Text>
						</PressableScale>
					) : (
						<>
							<Ionicons
								name="warning-outline"
								size={48}
								color="#9ca3af"
							/>
							<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">
								{phase === "unsupported" ? t("pdf_preview_unsupported") : t("unable_to_load_pdf")}
							</Text>
						</>
					)}
				</View>
			)}
		</View>
	)
}

export default PdfPreview
