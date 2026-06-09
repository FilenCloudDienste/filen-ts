import secureStore, { useSecureStore } from "@/lib/secureStore"
import i18n from "@/lib/i18n"
import { useTranslation } from "react-i18next"
import useAppStore from "@/stores/useApp.store"
import { fetchData } from "@/queries/useLocalAuthentication.query"
import { type Biometric as TBiometric } from "@/features/settings/screens/biometric"
import useEffectOnce from "@/hooks/useEffectOnce"
import { Platform, AppState, type AppStateStatus } from "react-native"
import { FullWindowOverlay } from "react-native-screens"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import * as LocalAuthentication from "expo-local-authentication"
import { useState, useEffect, useRef } from "react"
import { run, runEffect } from "@filen/utils"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { PressableOpacity } from "@/components/ui/pressables"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { withSystemPresentation, systemPresentation, useSystemPresentationStore } from "@/lib/systemPresentation"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Circle } from "react-native-svg"

const LOCK_MULTIPLIER_INITIAL = 1
const LOCK_MULTIPLIER_MAX_SECONDS = 3600
const LOCK_BASE_MS = 1000

export function remainingMs(now: number, lockedUntil: number): number {
	return Math.max(0, lockedUntil - now)
}

// P4: lock the moment we background (only while authenticated and not inside an in-app presentation),
// so the lock is already mounted before the app repaints on return — no content-leak frame. iOS
// suspends JS in the background, so this has to be decided at the background transition, not on return.
//
// This is a SECURITY gate, so it must fail CLOSED: consult ONLY whether a presentation is literally on
// screen (raw activeCount > 0), never the grace-inclusive re-lock suppression. At a real background the
// activeCount is already 0, so we lock; we only skip when a picker/permission/Face ID sheet is genuinely
// presented (which resigns the app active without truly leaving the app).
export function shouldLockOnBackground(enabled: boolean, authenticated: boolean, presentationActive: boolean): boolean {
	return enabled && authenticated && !presentationActive
}

// On return, auto-clear a background-induced lock without a prompt when we came back within the grace
// window (lockAfter). Beyond it the lock stays up and BiometricInner prompts.
export function shouldAutoUnlockOnForeground(
	lockedByBackground: boolean,
	elapsedMs: number,
	lockAfterMs: number,
	suppressed: boolean
): boolean {
	return lockedByBackground && !suppressed && elapsedMs <= lockAfterMs
}

// Re-evaluate on return so a real background that outlasted lockAfter re-locks even if the background
// transition itself was suppressed (scenario: iOS kept a picker promise pending the whole absence, so
// activeCount > 0 at background time and shouldLockOnBackground skipped). Grace-inclusive `suppressed`
// stays in the condition so returning straight from a picker (within the post-release grace) does NOT
// spuriously lock. This only fires for the still-authenticated case (the lock-on-background path already
// handles the common case), so the gate fails CLOSED on any genuine long absence.
export function shouldReLockOnForeground(
	enabled: boolean,
	authenticated: boolean,
	elapsedMs: number,
	lockAfterMs: number,
	suppressed: boolean
): boolean {
	return enabled && authenticated && !suppressed && elapsedMs > lockAfterMs
}

export type BiometricAppStateContext = {
	enabled: boolean
	authenticated: boolean
	// Raw "a presentation is literally on screen" (activeCount > 0). Drives the lock-on-background and
	// foreground re-lock decisions, which must fail CLOSED.
	presentationActive: boolean
	// Grace-inclusive re-lock suppression (active OR within the post-release grace window). Drives the
	// within-grace auto-unlock so returning straight from a picker doesn't spuriously lock.
	suppressed: boolean
	lockAfterMs: number
	wasBackground: boolean
	lockedByBackground: boolean
	lastAppCloseTimestamp: number
	now: number
}

export type BiometricAppStateResult = {
	wasBackground: boolean
	lockedByBackground: boolean
	lastAppCloseTimestamp: number
	// null = leave `authenticated` unchanged; otherwise call setAuthenticated(value).
	setAuthenticated: boolean | null
	// true = re-key BiometricInner (setLastAppOpenTimestamp) to restart the prompt.
	rekeyPrompt: boolean
}

// Pure reducer for the AppState lock machine (lock-on-background + within-grace auto-unlock). Extracted
// from the listener so the sticky-ref bookkeeping is unit-testable; the component just applies the result
// to its refs/setters. Each AppState event is one call; lastAppCloseTimestamp/wasBackground/lockedByBackground
// persist across calls via the component's refs.
export function reduceBiometricAppState(
	nextAppState: AppStateStatus,
	ctx: BiometricAppStateContext
): BiometricAppStateResult {
	let wasBackground = ctx.wasBackground
	let lockedByBackground = ctx.lockedByBackground
	let lastAppCloseTimestamp = ctx.lastAppCloseTimestamp
	let setAuthenticated: boolean | null = null
	let rekeyPrompt = false

	if (nextAppState === "background") {
		lastAppCloseTimestamp = ctx.now
		wasBackground = true

		// Lock at the moment of backgrounding (not on return) so the lock is already covering before the
		// app repaints content — no content-leak frame. Skipped ONLY while a presentation is literally on
		// screen (raw activeCount), never within the grace window — a security gate must fail CLOSED.
		if (shouldLockOnBackground(ctx.enabled, ctx.authenticated, ctx.presentationActive)) {
			lockedByBackground = true
			setAuthenticated = false
		}
	}

	// Sticky wasBackground instead of requiring the immediately-previous state to be "background": iOS can
	// deliver background → inactive → active, which would otherwise skip this whole block.
	if (nextAppState === "active" && wasBackground) {
		wasBackground = false

		const elapsed = ctx.now - lastAppCloseTimestamp

		// Returned within the grace window — clear the background lock without a prompt. Beyond it (or if we
		// never locked, e.g. a suppressed picker), leave state as-is so the lock stays up and prompts.
		if (shouldAutoUnlockOnForeground(lockedByBackground, elapsed, ctx.lockAfterMs, ctx.suppressed)) {
			setAuthenticated = true
		} else if (shouldReLockOnForeground(ctx.enabled, ctx.authenticated, elapsed, ctx.lockAfterMs, ctx.suppressed)) {
			// Background-lock was suppressed (a picker promise stayed pending the whole absence) yet we were
			// gone longer than lockAfter — fail CLOSED and re-lock now, prompting on return. Grace-inclusive
			// `suppressed` keeps a quick picker round-trip from spuriously locking.
			setAuthenticated = false
		}

		lockedByBackground = false
		rekeyPrompt = true
	}

	return {
		wasBackground,
		lockedByBackground,
		lastAppCloseTimestamp,
		setAuthenticated,
		rekeyPrompt
	}
}

const OVERLAY_CLASSES = "absolute top-0 left-0 right-0 bottom-0 z-10000 w-full h-full bg-background"

const ICON_BLOCK_SIZE = 80
const RING_RADIUS = 34
const RING_STROKE = 4
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const RING_DASHARRAY: [number, number] = [RING_CIRCUMFERENCE, RING_CIRCUMFERENCE]

type EnabledBiometric = TBiometric & {
	enabled: true
}

type PinResult =
	| {
			success: false
			error: "invalid_pin" | "cancelled"
	  }
	| {
			success: true
	  }

function Parent({ children }: { children: React.ReactNode }) {
	if (Platform.OS === "ios") {
		return <FullWindowOverlay>{children}</FullWindowOverlay>
	}

	return <View className="absolute top-0 left-0 right-0 bottom-0 z-10000 w-full h-full">{children}</View>
}

function nextLockState(prev: { lockedMultiplier: number }): { lockedUntil: number; lockedMultiplier: number } {
	const nextMultiplier = Math.min(LOCK_MULTIPLIER_MAX_SECONDS, prev.lockedMultiplier * 2)

	return {
		lockedUntil: Date.now() + LOCK_BASE_MS * nextMultiplier,
		lockedMultiplier: nextMultiplier
	}
}

async function promptBiometric(): Promise<LocalAuthentication.LocalAuthenticationResult> {
	const { hasHardware, isEnrolled } = await fetchData()

	if (!hasHardware || !isEnrolled) {
		return {
			success: false,
			error: "not_available"
		}
	}

	// Wrap the system prompt so the privacy cover (shown while the app is inactive) doesn't appear over
	// the Face ID / Touch ID sheet — the prompt resigns the app active without truly leaving it.
	return await withSystemPresentation(() =>
		LocalAuthentication.authenticateAsync({
			cancelLabel: i18n.t("cancel"),
			promptMessage: i18n.t("authenticate"),
			promptDescription: i18n.t("authenticate_to_access_app"),
			promptSubtitle: "",
			disableDeviceFallback: true,
			fallbackLabel: i18n.t("use_pin")
		})
	)
}

async function promptPin(biometric: EnabledBiometric): Promise<PinResult> {
	const pinPromptResult = await prompts.input({
		title: i18n.t("pin_code"),
		message: i18n.t("enter_pin"),
		cancelText: i18n.t("cancel"),
		okText: i18n.t("authenticate"),
		inputType: "secure-text"
	})

	if (pinPromptResult.cancelled || pinPromptResult.type !== "string") {
		return {
			success: false,
			error: "cancelled"
		}
	}

	const pin = pinPromptResult.value

	if (pin.length === 0) {
		return {
			success: false,
			error: "cancelled"
		}
	}

	if (biometric.fallback !== pin) {
		return {
			success: false,
			error: "invalid_pin"
		}
	}

	return {
		success: true
	}
}

async function applyAuthFailure(biometric: EnabledBiometric): Promise<void> {
	await secureStore.set("biometric", {
		...biometric,
		...nextLockState(biometric)
	} satisfies TBiometric)

	alerts.error(i18n.t("invalid_pin"))
}

async function applyAuthSuccess(biometric: EnabledBiometric, onSuccess: () => void): Promise<void> {
	// Unlock the UI FIRST — the user passed Face ID / entered the correct PIN, so they must never be stranded
	// behind a fallible disk write. Resetting the lock-escalation counter is only convenience; persist it as
	// best-effort and swallow a write failure (the stale lockedUntil/lockedMultiplier is harmless once `show`
	// is false). Never couple setAuthenticated(true) to secureStore.set.
	onSuccess()

	const result = await run(() =>
		secureStore.set("biometric", {
			...biometric,
			lockedMultiplier: LOCK_MULTIPLIER_INITIAL,
			lockedUntil: 0
		} satisfies TBiometric)
	)

	if (!result.success) {
		console.error(result.error)
	}
}

function AuthIconBlock() {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View
			className="bg-background-secondary rounded-full items-center justify-center"
			style={{
				width: ICON_BLOCK_SIZE,
				height: ICON_BLOCK_SIZE
			}}
		>
			<Ionicons
				name="lock-closed"
				size={36}
				color={textForeground.color}
			/>
		</View>
	)
}

function CountdownRing({ msLeft, totalMs }: { msLeft: number; totalMs: number }) {
	const textMuted = useResolveClassNames("text-muted")
	const textPrimary = useResolveClassNames("text-primary")
	const progress = totalMs > 0 ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0
	const dashOffset = RING_CIRCUMFERENCE * (1 - progress)
	const secondsLeft = Math.max(1, Math.ceil(msLeft / 1000))

	return (
		<View
			className="bg-background-secondary rounded-full items-center justify-center"
			style={{
				width: ICON_BLOCK_SIZE,
				height: ICON_BLOCK_SIZE
			}}
		>
			<Svg
				width={ICON_BLOCK_SIZE}
				height={ICON_BLOCK_SIZE}
				viewBox={`0 0 ${ICON_BLOCK_SIZE} ${ICON_BLOCK_SIZE}`}
				style={{
					position: "absolute"
				}}
			>
				<Circle
					cx={ICON_BLOCK_SIZE / 2}
					cy={ICON_BLOCK_SIZE / 2}
					r={RING_RADIUS}
					strokeWidth={RING_STROKE}
					stroke={textMuted.color}
					fill="none"
				/>
				<Circle
					cx={ICON_BLOCK_SIZE / 2}
					cy={ICON_BLOCK_SIZE / 2}
					r={RING_RADIUS}
					strokeWidth={RING_STROKE}
					stroke={textPrimary.color}
					fill="none"
					strokeDasharray={RING_DASHARRAY}
					strokeDashoffset={dashOffset}
					strokeLinecap="round"
					transform={`rotate(-90 ${ICON_BLOCK_SIZE / 2} ${ICON_BLOCK_SIZE / 2})`}
				/>
			</Svg>
			<Text className="text-foreground text-xl font-semibold">{secondsLeft}</Text>
		</View>
	)
}

function AuthShell({
	icon,
	heading,
	subtitle,
	action
}: {
	icon: React.ReactNode
	heading: string
	subtitle: string
	action?: React.ReactNode
}) {
	const insets = useSafeAreaInsets()

	return (
		<Parent>
			<AnimatedView
				className={OVERLAY_CLASSES}
				exiting={FadeOut}
			>
				<View
					className="items-center px-8"
					style={{
						paddingTop: insets.top + 96
					}}
				>
					{icon}
					<Text className="text-foreground text-2xl font-semibold mt-6">{heading}</Text>
					<Text className="text-muted-foreground text-base mt-2 text-center">{subtitle}</Text>
				</View>
				<View className="flex-1" />
				{action ? (
					<View
						className="px-6"
						style={{
							paddingBottom: insets.bottom + 16
						}}
					>
						{action}
					</View>
				) : null}
			</AnimatedView>
		</Parent>
	)
}

function PrimaryButton({ onPress, children }: { onPress: () => void; children: string }) {
	return (
		<PressableOpacity
			onPress={onPress}
			className="bg-primary rounded-xl py-3.5 items-center"
		>
			<Text className="text-primary-foreground text-base font-semibold">{children}</Text>
		</PressableOpacity>
	)
}

function BiometricInner({ setAuthenticated }: { setAuthenticated: React.Dispatch<React.SetStateAction<boolean>> }) {
	const { t } = useTranslation()
	const isPromptingRef = useRef<boolean>(false)

	const tryAuth = async (preferBiometric: boolean): Promise<void> => {
		const result = await run(async defer => {
			if (isPromptingRef.current) {
				return
			}

			isPromptingRef.current = true

			defer(() => {
				isPromptingRef.current = false
			})

			const biometric = await secureStore.get<TBiometric>("biometric")

			if (!biometric?.enabled) {
				return
			}

			if (preferBiometric && !biometric.pinOnly) {
				const biometricResult = await promptBiometric()

				if (!biometricResult.success) {
					return
				}

				await applyAuthSuccess(biometric, () => {
					setAuthenticated(true)
				})

				return
			}

			const pinResult = await promptPin(biometric)

			if (pinResult.success) {
				await applyAuthSuccess(biometric, () => {
					setAuthenticated(true)
				})

				return
			}

			if (pinResult.error === "invalid_pin") {
				await applyAuthFailure(biometric)
			}
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	useEffectOnce(() => {
		;(async () => {
			await tryAuth(true).catch(console.error)
		})()
	})

	return (
		<AuthShell
			icon={<AuthIconBlock />}
			heading={t("authenticate")}
			subtitle={t("unlock_to_continue")}
			action={
				<PrimaryButton
					onPress={async () => {
						await tryAuth(false).catch(console.error)
					}}
				>
					{t("use_pin")}
				</PrimaryButton>
			}
		/>
	)
}

function Locked({ lockedUntil, lockSeconds }: { lockedUntil: number; lockSeconds: number }) {
	const { t } = useTranslation()
	const [msLeft, setMsLeft] = useState<number>(() => Math.max(0, lockedUntil - new Date().getTime()))
	const [, setBiometric] = useSecureStore<TBiometric>("biometric", {
		enabled: false
	})
	const totalMs = lockSeconds * LOCK_BASE_MS

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const interval = setInterval(() => {
				const ms = remainingMs(Date.now(), lockedUntil)

				if (ms <= 0) {
					clearInterval(interval)
					setMsLeft(0)

					setBiometric(prev => {
						if (!prev.enabled) {
							return prev
						}

						return {
							...prev,
							lockedUntil: 0
						}
					})

					return
				}

				setMsLeft(ms)
			}, 1000)

			defer(() => {
				clearInterval(interval)
			})
		})

		return () => {
			cleanup()
		}
	}, [lockedUntil, setBiometric])

	return (
		<AuthShell
			icon={
				<CountdownRing
					msLeft={msLeft}
					totalMs={totalMs}
				/>
			}
			heading={t("app_locked")}
			subtitle={t("too_many_failed_attempts")}
		/>
	)
}

function Biometric() {
	const [biometric] = useSecureStore<TBiometric>("biometric", {
		enabled: false
	})
	const [authenticated, setAuthenticated] = useState<boolean>(false)
	const [lastAppOpenTimestamp, setLastAppOpenTimestamp] = useState<number>(0)
	const lastAppCloseTimestampRef = useRef<number>(0)
	const wasBackgroundRef = useRef<boolean>(false)
	const lockAfterMsRef = useRef<number>(biometric.enabled ? biometric.lockAfter * LOCK_BASE_MS : 0)
	const biometricEnabledRef = useRef<boolean>(biometric.enabled)
	const authenticatedRef = useRef<boolean>(authenticated)
	const lockedByBackgroundRef = useRef<boolean>(false)

	useEffect(() => {
		lockAfterMsRef.current = biometric.enabled ? biometric.lockAfter * LOCK_BASE_MS : 0
		biometricEnabledRef.current = biometric.enabled
	}, [biometric])

	useEffect(() => {
		authenticatedRef.current = authenticated
	}, [authenticated])

	const [, setLockTick] = useState<number>(0)

	const lockedUntil = biometric.enabled ? biometric.lockedUntil : 0
	const show = biometric.enabled && !authenticated
	const locked = biometric.enabled && new Date().getTime() < lockedUntil

	// Self-owned clock timer so the <Locked> → unlock transition is driven by the wall clock, not by the
	// (fallible) secureStore write that emits secureStoreChange. `locked` is recomputed from Date.now() on
	// every render, so this one-shot timeout forces a re-render at expiry that drops us out of <Locked>
	// regardless of whether the persisted lockedUntil:0 reset actually landed on disk.
	useEffect(() => {
		if (!locked) {
			return
		}

		const id = setTimeout(() => {
			setLockTick(t => t + 1)
		}, remainingMs(Date.now(), lockedUntil) + 50)

		return () => {
			clearTimeout(id)
		}
	}, [locked, lockedUntil])

	useEffect(() => {
		useAppStore.getState().setBiometricUnlocked(!show)
	}, [show])

	useEffect(() => {
		return () => {
			useAppStore.getState().setBiometricUnlocked(null)
		}
	}, [])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateListener = AppState.addEventListener("change", nextAppState => {
				const now = Date.now()

				const result = reduceBiometricAppState(nextAppState, {
					enabled: biometricEnabledRef.current,
					authenticated: authenticatedRef.current,
					presentationActive: systemPresentation.isActive(),
					suppressed: systemPresentation.isReLockSuppressed(now),
					lockAfterMs: lockAfterMsRef.current,
					wasBackground: wasBackgroundRef.current,
					lockedByBackground: lockedByBackgroundRef.current,
					lastAppCloseTimestamp: lastAppCloseTimestampRef.current,
					now
				})

				wasBackgroundRef.current = result.wasBackground
				lockedByBackgroundRef.current = result.lockedByBackground
				lastAppCloseTimestampRef.current = result.lastAppCloseTimestamp

				if (result.setAuthenticated !== null) {
					setAuthenticated(result.setAuthenticated)
				}

				if (result.rekeyPrompt) {
					setLastAppOpenTimestamp(now)
				}
			})

			// Residual hardening for scenario (a): iOS suspended JS with a picker promise still pending, so the
			// background transition was suppressed (activeCount > 0) and never set wasBackground/lockedByBackground.
			// On return the app is already "active" (the foreground re-evaluation ran with stale wasBackground),
			// and the picker only dismisses afterwards — firing end() → activeCount 1->0. Re-evaluate the re-lock
			// at that moment so a long absence behind a still-open picker locks as soon as the picker dismisses.
			// This fires exactly on the 1->0 transition (activeCount is now 0 → nothing literally on screen) and the
			// post-release grace has only just started here, so the decision rests solely on elapsed > lockAfter —
			// a genuine long absence fails CLOSED, while a quick picker round-trip stays under lockAfter and clears.
			const presentationUnsub = useSystemPresentationStore.subscribe((state, prevState) => {
				if (!(prevState.activeCount > 0 && state.activeCount === 0)) {
					return
				}

				if (AppState.currentState !== "active") {
					return
				}

				const now = Date.now()
				const elapsed = now - lastAppCloseTimestampRef.current

				if (shouldReLockOnForeground(biometricEnabledRef.current, authenticatedRef.current, elapsed, lockAfterMsRef.current, false)) {
					setAuthenticated(false)
					setLastAppOpenTimestamp(now)
				}
			})

			defer(() => {
				appStateListener.remove()
				presentationUnsub()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	if (!show) {
		return null
	}

	if (locked && biometric.enabled) {
		return (
			<Locked
				lockedUntil={biometric.lockedUntil}
				lockSeconds={biometric.lockedMultiplier}
			/>
		)
	}

	return (
		<BiometricInner
			key={lastAppOpenTimestamp}
			setAuthenticated={setAuthenticated}
		/>
	)
}

export default Biometric
