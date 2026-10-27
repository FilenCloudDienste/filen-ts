import { defaultPresenterFeatures } from "./portal"

// Where the presenter view and the audience go when the page may see every screen (the Window Management API,
// permission "window-management"): the presenter view on the screen the page is on, the audience full screen on
// another. Never asks for the permission itself (that prompt would spend the click that opens the popup); it uses
// the screens only once the user has granted it, and the details are read ahead of the click, since window.open
// must run inside it.

export interface ScreenDetailedLike {
	readonly availLeft: number
	readonly availTop: number
	readonly availWidth: number
	readonly availHeight: number
	readonly isPrimary?: boolean
	readonly isInternal?: boolean
	readonly label?: string
}

interface ScreenDetailsLike {
	readonly screens: readonly ScreenDetailedLike[]
	readonly currentScreen: ScreenDetailedLike
}

export interface ScreenPlacement {
	// Reads the screens when the permission is already granted; resolves whether it is.
	refresh(): Promise<boolean>
	// window.open features for the presenter view.
	features(): string
	// Options for the audience's requestFullscreen (a screen other than the presenter's).
	fullscreenOptions(): FullscreenOptions | undefined
}

// The screen the audience sees: an external one before an internal one, the primary one last (a laptop's own
// panel is internal and primary).
export function audienceScreenOf(details: ScreenDetailsLike): ScreenDetailedLike | undefined {
	const others = details.screens.filter(screen => screen !== details.currentScreen)
	const rank = (screen: ScreenDetailedLike): number => (screen.isInternal === true ? 2 : 0) + (screen.isPrimary === true ? 1 : 0)

	return others.slice().sort((a, b) => rank(a) - rank(b))[0]
}

export function presenterFeaturesOn(screen: ScreenDetailedLike): string {
	return `popup,left=${String(screen.availLeft)},top=${String(screen.availTop)},width=${String(screen.availWidth)},height=${String(screen.availHeight)}`
}

export function createScreenPlacement(opener: Window): ScreenPlacement {
	let details: ScreenDetailsLike | undefined

	return {
		refresh: async () => {
			const getScreenDetails: unknown = Reflect.get(opener, "getScreenDetails")
			const permissions = opener.navigator.permissions as Permissions | undefined

			if (typeof getScreenDetails !== "function" || permissions === undefined) return false

			try {
				const status = await permissions.query({ name: "window-management" as PermissionName })

				if (status.state !== "granted") {
					details = undefined

					return false
				}

				details = (await Reflect.apply(getScreenDetails, opener, [])) as ScreenDetailsLike

				return true
			} catch {
				// Unknown permission name (Firefox, Safari) or a refused read.
				details = undefined

				return false
			}
		},
		features: () =>
			details !== undefined && audienceScreenOf(details) !== undefined
				? presenterFeaturesOn(details.currentScreen)
				: defaultPresenterFeatures(opener),
		fullscreenOptions: () => {
			const screen = details === undefined ? undefined : audienceScreenOf(details)

			return screen === undefined ? undefined : ({ navigationUI: "hide", screen } as FullscreenOptions)
		}
	}
}
