import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

// Standard OS tab bar heights. NativeTabs (expo-router) wraps native UITabBar
// (iOS) and BottomNavigationView (Android) which the JS layer can't measure
// directly. These constants reflect the documented OS standards.
//
// iOS: UITabBar standard height is 49pt (Apple HIG). The safe-area inset
// (home indicator / Dynamic Island bottom) is reported separately by
// react-native-safe-area-context and must be added.
//
// Android: BottomNavigationView (Material) overlays content; the floating bar
// must clear both the system nav bar (insets.bottom under edge-to-edge) AND
// the BottomNavigationView height. The Material 3 default is 80dp; older
// Material implementations use 56dp. expo-router unstable-native-tabs renders
// at the Material 3 default, so 80dp is the right baseline. Tune here if the
// bar visually overlaps on a specific device.
//
// If a future OS update breaks these assumptions, change the constant here
// — every floating-above-tabs surface uses this hook.
const IOS_TAB_BAR_HEIGHT = 49
const ANDROID_TAB_BAR_HEIGHT = 80
const FLOATING_BAR_GAP = 8

export function useFloatingBarOffset(): number {
	const insets = useSafeAreaInsets()

	return (
		Platform.select({
			ios: insets.bottom + IOS_TAB_BAR_HEIGHT + FLOATING_BAR_GAP,
			default: insets.bottom + ANDROID_TAB_BAR_HEIGHT + FLOATING_BAR_GAP
		}) ?? FLOATING_BAR_GAP
	)
}

export default useFloatingBarOffset
