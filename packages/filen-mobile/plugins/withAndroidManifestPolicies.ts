import { withAndroidManifest, type ConfigPlugin } from "@expo/config-plugins"

type AndroidManifestPoliciesOptions = {
	/**
	 * Bare URL schemes (no `:` or `//`) the app asks the OS about, passed in from app.config.ts so the
	 * manifest stays driven by EXTERNAL_LINK_PROTOCOLS rather than a second hand-kept list.
	 */
	schemes: string[]
}

/**
 * The `<queries>` block, which Expo's config schema does not expose.
 *
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
 */
const withAndroidManifestPolicies: ConfigPlugin<AndroidManifestPoliciesOptions> = (config, { schemes }) => {
	return withAndroidManifest(config, async config => {
		const manifest = config.modResults.manifest
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
