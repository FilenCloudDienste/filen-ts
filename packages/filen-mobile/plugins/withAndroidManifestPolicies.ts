import { withAndroidManifest, type ConfigPlugin, AndroidConfig } from "@expo/config-plugins"

type AndroidManifestPoliciesOptions = {
	/**
	 * Bare URL schemes (no `:` or `//`) the app asks the OS about, passed in from app.config.ts so the
	 * manifest stays driven by EXTERNAL_LINK_PROTOCOLS rather than a second hand-kept list.
	 */
	schemes: string[]
}

/**
 * Two things Expo's config schema does not expose: `android:supportsRtl`, and the `<queries>` block.
 *
 * ── <queries> ──
 * Android 11 (API 30) package visibility filters what `PackageManager.queryIntentActivities` — and
 * therefore `Linking.canOpenURL` — can see. A scheme not declared here reports "no handler" even when
 * a handler is installed, so `useOpenExternalLink` takes its cannot-open branch and shows an error
 * for a link that would have opened perfectly. Only `https` was declared, which is why `mailto:` and
 * `tel:` links from a document or note were dead on Android 12+ while working on iOS.
 *
 * The entries are derived from the app's own external-link allowlist, so a scheme can never be
 * openable at runtime but invisible to the OS query. They carry no `<category>`: intent resolution
 * treats a category-less intent as CATEGORY_DEFAULT, which every launchable activity declares, so
 * this matches strictly more handlers than pinning BROWSABLE would. Pre-existing entries (Expo's own
 * `https` intent) are preserved untouched rather than replaced.
 *
 * ── supportsRtl ──
 * Set to FALSE deliberately, and it is not cosmetic on React Native: RN's `I18nUtil.isRTL()` is gated
 * on `applicationHasRtlSupport()`, which reads this exact flag. Turning it off makes RN report LTR
 * from the very first launch on an RTL device — no shared-preferences round trip, no mirrored first
 * launch. None of the shipped locales is right-to-left and no screen has been laid out or reviewed
 * mirrored, so the surface an Arabic/Hebrew device used to get was never a supported one. iOS has no
 * equivalent manifest gate; src/global.ts calls I18nManager.allowRTL(false) to cover it.
 */
const withAndroidManifestPolicies: ConfigPlugin<AndroidManifestPoliciesOptions> = (config, { schemes }) => {
	return withAndroidManifest(config, async config => {
		const manifest = config.modResults.manifest
		const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)

		application.$["android:supportsRtl"] = "false"

		const queries = manifest.queries ?? []
		const intents = queries[0]?.intent ?? []

		for (const scheme of schemes) {
			const alreadyDeclared = intents.some(intent =>
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(intent.data ?? []).some((data: any) => data?.$?.["android:scheme"] === scheme)
			)

			if (alreadyDeclared) {
				continue
			}

			intents.push({
				action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
				data: [{ $: { "android:scheme": scheme } }]
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
		}

		if (queries.length === 0) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			queries.push({ intent: intents } as any)
		} else if (queries[0]) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(queries[0] as any).intent = intents
		}

		manifest.queries = queries

		return config
	})
}

export default withAndroidManifestPolicies
