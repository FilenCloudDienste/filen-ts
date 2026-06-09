import { type TFunction } from "i18next"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import events from "@/lib/events"
import fileProvider from "@/features/settings/fileProvider"
import { type Biometric } from "@/features/settings/screens/biometric"

export function disableBiometric({ setBiometric }: { setBiometric: (value: Biometric) => void }) {
	setBiometric({ enabled: false })
}

export async function enableBiometric({
	setBiometric,
	fileProviderEnabled,
	setFileProviderEnabled,
	t,
	biometric: _biometric
}: {
	setBiometric: (value: Biometric | ((prev: Biometric) => Biometric)) => void
	fileProviderEnabled: boolean
	setFileProviderEnabled: (value: boolean) => void
	t: TFunction
	biometric?: Biometric
}) {
	// If the file/documents provider is on, warn the user
	// that enabling biometric will disable it. The native
	// provider extensions read auth.json directly and
	// bypass the JS biometric gate, so having both on at
	// the same time creates a false sense of security.
	// NOTE: we only show the warning here — the actual
	// disable() is deferred until AFTER the fallback password
	// is validated, so a cancel/mismatch leaves the provider intact.
	if (fileProviderEnabled) {
		const confirmProviderDisableResult = await run(async () => {
			return await prompts.alert({
				title: t("biometric_disables_file_provider_title"),
				message: t("biometric_disables_file_provider_message"),
				okText: t("continue"),
				cancelText: t("cancel")
			})
		})

		if (!confirmProviderDisableResult.success) {
			console.error(confirmProviderDisableResult.error)
			alerts.error(confirmProviderDisableResult.error)

			return
		}

		if (confirmProviderDisableResult.data.cancelled) {
			return
		}
	}

	const fallbackPromptResult = await run(async () => {
		return await prompts.input({
			title: t("fallback_password"),
			message: t("enter_fallback_password"),
			cancelText: t("cancel"),
			okText: t("continue"),
			inputType: "secure-text"
		})
	})

	if (!fallbackPromptResult.success) {
		console.error(fallbackPromptResult.error)
		alerts.error(fallbackPromptResult.error)

		return
	}

	if (fallbackPromptResult.data.cancelled || fallbackPromptResult.data.type !== "string") {
		return
	}

	const fallbackPassword = fallbackPromptResult.data.value

	if (fallbackPassword.length === 0) {
		return
	}

	const confirmFallbackPasswordPromptResult = await run(async () => {
		return await prompts.input({
			title: t("fallback_password"),
			message: t("enter_confirm_fallback_password"),
			cancelText: t("cancel"),
			okText: t("save"),
			inputType: "secure-text"
		})
	})

	if (!confirmFallbackPasswordPromptResult.success) {
		console.error(confirmFallbackPasswordPromptResult.error)
		alerts.error(confirmFallbackPasswordPromptResult.error)

		return
	}

	if (confirmFallbackPasswordPromptResult.data.cancelled || confirmFallbackPasswordPromptResult.data.type !== "string") {
		return
	}

	const confirmFallbackPassword = confirmFallbackPasswordPromptResult.data.value

	if (confirmFallbackPassword.length === 0) {
		return
	}

	if (fallbackPassword !== confirmFallbackPassword) {
		alerts.error(t("fallback_passwords_do_not_match"))

		return
	}

	// Password validated — now it is safe to disable the file provider.
	// Any abort/cancel before this point left the provider untouched.
	if (fileProviderEnabled) {
		const disableProviderResult = await run(async () => {
			await fileProvider.disable()
		})

		if (!disableProviderResult.success) {
			console.error(disableProviderResult.error)
			alerts.error(disableProviderResult.error)

			return
		}

		setFileProviderEnabled(false)
	}

	// Seed the always-mounted lock overlay as "already authenticated for this session" BEFORE the
	// enabled:true write becomes visible. The overlay's listener runs synchronously at emit time and
	// queues setAuthenticated(true); the secureStore write below is async, so by the time the overlay
	// re-renders with enabled === true, authenticated is already true → no lock, no flash. The user is
	// present and just completed the fallback-password double-prompt, so locking them out immediately is
	// wrong — the first real lock happens on the next background/app-open. Cold start is unaffected: the
	// overlay's authenticated defaults to false and this event never fires at launch.
	events.emit("biometricEnabledInSession")

	setBiometric({
		lockAfter: 0,
		enabled: true,
		fallback: fallbackPassword,
		lockedUntil: 0,
		pinOnly: false,
		lockedMultiplier: 1
	})
}
