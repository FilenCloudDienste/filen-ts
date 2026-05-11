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
// Android: with react-native-edge-to-edge enabled, BottomNavigationView is
// laid out by the OS such that its visual height is already absorbed in the
// view tree — content above it does NOT need to add the bar height because
// the tab bar sits inside the same safe area window. Only a small margin is
// needed between floating UI and the tab bar.
//
// If a future OS update breaks these assumptions, change the constant here
// — every floating-above-tabs surface uses this hook.
const IOS_TAB_BAR_HEIGHT = 49
const FLOATING_BAR_GAP = 8

export function useFloatingBarOffset(): number {
	const insets = useSafeAreaInsets()

	return Platform.select({
		ios: insets.bottom + IOS_TAB_BAR_HEIGHT + FLOATING_BAR_GAP,
		default: FLOATING_BAR_GAP
	}) ?? FLOATING_BAR_GAP
}

export default useFloatingBarOffset
