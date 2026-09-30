import useAppStore from "@/stores/useApp.store"
import useIsAppActive from "@/hooks/useIsAppActive"

// Reactive twin of isUnlockedForeground (lib/unlockedForeground): the app is in front and no biometric lock covers it.
export default function useIsUnlockedForeground(): boolean {
	const unlocked = useAppStore(state => state.biometricUnlocked === true)
	const active = useIsAppActive()

	return unlocked && active
}
