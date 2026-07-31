import { useEffect, useRef, useState } from "react"
import { ActivityIndicator } from "react-native"
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import { run } from "@filen/utils"
import Dom from "@/components/pdfPreview/dom"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import View from "@/components/ui/view"
import { parsePdfExternalLink, parsePdfViewerEvent, type PdfPasswordResponse, type PdfSaveRequest } from "@/components/pdfPreview/protocol"
import usePdfSaveTarget from "@/components/pdfPreview/usePdfSaveTarget"
import type { File } from "expo-file-system"
import { forwardDomConsoleLog } from "@/hooks/useDomEvents/forwardDomLog"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import type { WebViewMessageEvent } from "react-native-webview"
import { useResolveClassNames } from "uniwind"

type Phase = "loading" | "ready" | "unsupported" | "error" | "passwordCancelled"

// How long to wait for the viewer to announce itself before deciding the WebView is not going to
// boot. Generous, because it covers bundle parse on a cold, slow device — but finite, because the
// alternative is an opaque overlay with nothing behind it and no way out.
//
// This budget covers BOOT ONLY, and is cancelled the moment the viewer says `ready`. It deliberately
// does not cover opening or painting the document: a large file can legitimately take longer than
// this, and a password prompt can sit open for as long as the user needs. Timing those here turned a
// slow document — or a user typing carefully — into a hard error. Once the viewer is alive, failures
// arrive as events, so there is nothing left for a timer to catch.
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
	readOnly,
	onEditedChange,
	saveHandleRef,
	paddingTop,
	paddingBottom,
	paddingLeft,
	paddingRight
}: {
	readRange: (offset: number, length: number) => Promise<string>
	fileSize: number
	readOnly: boolean
	onEditedChange: (edited: boolean) => void
	/** Filled with a function that serialises the document to a temp file, or null when not editable. */
	saveHandleRef: { current: (() => Promise<File | null>) | null }
	paddingTop?: number
	paddingBottom?: number
	paddingLeft?: number
	paddingRight?: number
}) => {
	const { t } = useTranslation()
	const openExternalLink = useOpenExternalLink("pdfPreview")
	const [phase, setPhase] = useState<Phase>("loading")
	const [passwordResponse, setPasswordResponse] = useState<PdfPasswordResponse | null>(null)
	const [booted, setBooted] = useState<boolean>(false)
	const [saveRequest, setSaveRequest] = useState<PdfSaveRequest | null>(null)
	const saveTarget = usePdfSaveTarget()
	const saveResolverRef = useRef<((file: File | null) => void) | null>(null)
	const promptingRef = useRef<boolean>(false)
	const lastRequestIdRef = useRef<string | null>(null)
	const lastPasswordIncorrectRef = useRef<boolean>(false)
	const bgBackground = useResolveClassNames("bg-background")

	// The viewer posts `ready` once its bundle has evaluated and its capability checks have passed. If
	// that never arrives, nothing else will either — no document, no error — so the overlay would stay
	// up forever.
	useEffect(() => {
		if (booted || phase !== "loading") {
			return
		}

		const timeout = setTimeout(() => {
			logger.error("pdfPreview", "the viewer did not report ready in time")

			setPhase("error")
		}, BOOT_TIMEOUT_MS)

		return () => {
			clearTimeout(timeout)
		}
	}, [booted, phase])

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

			alerts.error(result.error)

			// Recoverable: the prompt failed, not the document. Leaving the retry affordance up beats a
			// dead-end error for something a second tap may well survive.
			setPhase("passwordCancelled")

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

	// Serialising happens inside the WebView, so the host asks for it through a prop and settles the
	// promise when the viewer reports back. Mirrors the password round trip.
	useEffect(() => {
		saveHandleRef.current = readOnly
			? null
			: () =>
					new Promise<File | null>(resolve => {
						saveTarget.begin()

						saveResolverRef.current = resolve

						setSaveRequest({
							requestId: `${Date.now()}`
						})
					})

		return () => {
			saveHandleRef.current = null

			saveTarget.discard()
		}
	}, [readOnly, saveHandleRef, saveTarget])

	return (
		<View className="flex-1 bg-background">
			<Dom
				readRange={readRange}
				writeChunk={saveTarget.writeChunk}
				fileSize={fileSize}
				readOnly={readOnly}
				passwordResponse={passwordResponse}
				saveRequest={saveRequest}
				paddingTop={paddingTop}
				paddingBottom={paddingBottom}
				paddingLeft={paddingLeft}
				paddingRight={paddingRight}
				background={bgBackground.backgroundColor as string}
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

								case "edited": {
									onEditedChange(true)

									break
								}

								case "saved": {
									setSaveRequest(null)

									saveResolverRef.current?.(saveTarget.finish())
									saveResolverRef.current = null

									break
								}

								case "saveFailed": {
									logger.error("pdfPreview", "the viewer could not serialise the document")

									setSaveRequest(null)
									saveTarget.discard()

									saveResolverRef.current?.(null)
									saveResolverRef.current = null

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
									// Boot handshake: the WebView is alive. Retires the boot watchdog — the document
									// may still fail, but a failure now arrives as an event rather than as silence.
									setBooted(true)

									break
								}

								case "passwordRequired": {
									setPasswordResponse(null)

									lastRequestIdRef.current = viewerEvent.requestId
									lastPasswordIncorrectRef.current = viewerEvent.reason === "incorrect"

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

								promptForPassword(requestId, lastPasswordIncorrectRef.current).catch(err => {
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
