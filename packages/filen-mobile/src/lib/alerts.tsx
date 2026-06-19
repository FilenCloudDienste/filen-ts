import * as Burnt from "burnt"
import { Notifier, NotifierComponents } from "react-native-notifier"
import View from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { unwrapSdkError, unwrappedSdkErrorToHumanReadable } from "@/lib/sdkErrors"
import i18n from "@/lib/i18n"

const NotifierErrorContainer = ({ children }: { children: React.ReactNode }) => {
	const insets = useSafeAreaInsets()

	// Must NOT be `position: absolute`. react-native-notifier hides the banner by translating it
	// off-screen by the height it measures via onLayout on its content wrapper; an absolutely-positioned
	// container collapses that measurement to ~0, so the hide falls back to DEFAULT_COMPONENT_HEIGHT
	// (200px) and any taller banner leaves a red strip stuck at the top. The lib's own container is
	// already `position: absolute; top: 0; width: 100%`, so this flows full-width at the top regardless.
	// paddingTop spans the status-bar inset (the notifier renders in a FullWindowOverlay above it).
	return (
		<View
			style={{
				paddingTop: insets.top
			}}
			className="bg-red-500"
		>
			{children}
		</View>
	)
}

// Plain object namespace (no instance state) — toast/error-banner helpers. Kept as a
// single exported object so the ~73 `alerts.error(...)` / `alerts.normal(...)` call sites
// stay unchanged; the former `class Alerts` added no value (zero fields, zero `this`).
export const alerts = {
	error(message: unknown): void {
		const unwrappedSdkError = unwrapSdkError(message)
		const description = unwrappedSdkError
			? unwrappedSdkErrorToHumanReadable(unwrappedSdkError)
			: message instanceof Error
				? message.message
				: String(message)

		Notifier.showNotification({
			title: i18n.t("error"),
			description,
			duration: 3000,
			Component: NotifierComponents.Alert,
			componentProps: {
				alertType: "error",
				ContainerComponent: NotifierErrorContainer,
				maxDescriptionLines: 16,
				maxTitleLines: 1
			},
			containerStyle: {
				zIndex: 1000
			}
		})
	},
	normal(title: string): void {
		Burnt.toast({
			title,
			duration: 3,
			preset: "done",
			shouldDismissByDrag: true,
			from: "bottom",
			haptic: "none"
		})
	}
}

export default alerts
