import { create } from "zustand"

export type AppStore = {
	pathname: string
	setPathname: (fn: string | ((prev: string) => string)) => void
	// null = unknown (initial). false = biometric/PIN lock is currently up.
	// true = either biometric is not enabled, or it has been cleared.
	// Initial null is critical: any side-effect that depends on the lock
	// being cleared should fail-closed against null during the brief window
	// before <Biometric /> publishes its state.
	biometricUnlocked: boolean | null
	setBiometricUnlocked: (value: boolean | null) => void
}

export const useAppStore = create<AppStore>(set => ({
	pathname: "/",
	setPathname(fn) {
		set(state => ({
			pathname: typeof fn === "function" ? fn(state.pathname) : fn
		}))
	},
	biometricUnlocked: null,
	setBiometricUnlocked(value) {
		set({
			biometricUnlocked: value
		})
	}
}))

export default useAppStore
