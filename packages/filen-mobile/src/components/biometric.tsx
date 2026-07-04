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
import events from "@/lib/events"
import logger from "@/lib/logger"
import { withSystemPresentation, systemPresentation, useSystemPresentationStore } from "@/lib/systemPresentation"
import usePipStore from "@/stores/usePip.store"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Circle } from "react-native-svg"

const LOCK_MULTIPLIER_INITIAL = 1
const LOCK_MULTIPLIER_MAX_SECONDS = 3600
const LOCK_BASE_MS = 1000

// PiP session suppression (spec: docs/pip-video-player.md §5.6.1) — an active Picture-in-Picture
// session extends the foreground session, modeled on the systemPresentation suppression: sticky
// flag AND grace. The graces absorb the platform-dependent ordering of the PiP events vs the
// AppState transitions; with the enable-time default lockAfter of 0 ("immediately") there is no
// accidental slack, so these are load-bearing, not defensive.
//
// PIP_STOP_GRACE_MS: on expand-back the PiP-stop event can be delivered BEFORE the "active"
// AppState event — the stop-side subscription then locks (fail closed), and this grace lets the
// imminent "active" auto-unlock it (mirror of systemPresentation's RELOCK_SUPPRESSION_GRACE_MS).
export const PIP_STOP_GRACE_MS = 1500
// PIP_START_RETRO_UNLOCK_MS: on auto-enter the "background" event can reach the reducer BEFORE the
// PiP-start event — the reducer then locks normally; a PiP-start arriving within this window of
// that lock retro-unlocks it (the window is bounded so a genuinely stale start event fails closed).
export const PIP_START_RETRO_UNLOCK_MS = 2500

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
// presented (which resigns the app active without truly leaving the app) — or while a Picture-in-Picture
// session is active (user-initiated OS surface that keeps the app logically open; the PiP-stop
// subscription fails closed the moment the session ends, see the pip handling in <Biometric />).
export function shouldLockOnBackground(
	enabled: boolean,
	authenticated: boolean,
	presentationActive: boolean,
	pipSessionActive: boolean
): boolean {
	return enabled && authenticated && !presentationActive && !pipSessionActive
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

// Residual fail-closed decision for the "picker dismissed AFTER the app already returned active" race
// (scenario a): iOS kept a picker promise pending past the foreground transition, so the reducer's
// foreground re-lock could not act (the picker was still suppressing it). This fires on the activeCount
// 1->0 transition once the picker finally dismisses.
//
// The arbiter is the explicit `backgroundedBehindPresentation` flag — set ONLY when a REAL background event
// fired while a presentation was literally on screen — NOT a bare elapsed > lockAfter against a possibly
// stale/zero lastAppCloseTimestamp. An ordinary in-app picker resigns the app to "inactive", never
// "background", so no close timestamp is ever stamped; without this flag a fresh session
// (lastAppCloseTimestamp 0 → astronomically large elapsed) or any picker used longer than lockAfter after
// the last real background would spuriously throw the user to the lock screen. When the flag IS set,
// lastAppCloseTimestamp was stamped by that same background event, so elapsedMs is real and a genuine long
// absence behind a still-pending picker still fails CLOSED.
export function shouldReLockOnPresentationEnd(
	enabled: boolean,
	authenticated: boolean,
	backgroundedBehindPresentation: boolean,
	elapsedMs: number,
	lockAfterMs: number
): boolean {
	return enabled && authenticated && backgroundedBehindPresentation && elapsedMs > lockAfterMs
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
	// Sticky: a REAL background event fired while a presentation was literally on screen, so the
	// lock-on-background was suppressed and the foreground re-lock has not yet been resolved. The residual
	// presentation-end subscription consults this (NOT a stale timestamp) to fail closed when the picker
	// finally dismisses.
	backgroundedBehindPresentation: boolean
	// A Picture-in-Picture session is currently active (usePipStore.activeKey !== null at event time).
	pipSessionActive: boolean
	// Sticky (mirror of backgroundedBehindPresentation): a REAL background fired while a PiP session
	// was active, so the lock-on-background was suppressed. Cleared when the session resolves —
	// expand-back (foreground with PiP still active) or PiP-stop (which locks, fail closed).
	backgroundedDuringPipSession: boolean
	// A PiP-stop-induced lock happened within PIP_STOP_GRACE_MS of `now` — the "active" auto-unlock
	// widens its window to max(lockAfterMs, PIP_STOP_GRACE_MS) so an expand-back whose stop event
	// landed just before "active" stays promptless even at lockAfter 0.
	pipStopGraceApplies: boolean
	lastAppCloseTimestamp: number
	now: number
}

export type BiometricAppStateResult = {
	wasBackground: boolean
	lockedByBackground: boolean
	backgroundedBehindPresentation: boolean
	backgroundedDuringPipSession: boolean
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
	let backgroundedBehindPresentation = ctx.backgroundedBehindPresentation
	let backgroundedDuringPipSession = ctx.backgroundedDuringPipSession
	let lastAppCloseTimestamp = ctx.lastAppCloseTimestamp
	let setAuthenticated: boolean | null = null
	let rekeyPrompt = false

	if (nextAppState === "background") {
		lastAppCloseTimestamp = ctx.now
		wasBackground = true

		// Lock at the moment of backgrounding (not on return) so the lock is already covering before the
		// app repaints content — no content-leak frame. Skipped ONLY while a presentation is literally on
		// screen (raw activeCount) or a PiP session is active, never within the grace window — a security
		// gate must fail CLOSED.
		if (shouldLockOnBackground(ctx.enabled, ctx.authenticated, ctx.presentationActive, ctx.pipSessionActive)) {
			lockedByBackground = true
			setAuthenticated = false
			backgroundedBehindPresentation = false
			backgroundedDuringPipSession = false
		} else if (ctx.presentationActive) {
			// A REAL background fired while a presentation was literally on screen, so the lock-on-background
			// was suppressed. Remember it (with lastAppCloseTimestamp stamped just above) so the residual
			// presentation-end subscription can fail CLOSED if the absence outlasts lockAfter once the picker
			// finally dismisses. This is the ONLY place the flag is set — an ordinary picker (resign-active →
			// "inactive", no background event) never reaches here, so it never arms the residual re-lock.
			backgroundedBehindPresentation = true
		} else if (ctx.pipSessionActive && ctx.enabled && ctx.authenticated) {
			// A REAL background fired while a PiP session was active — the lock-on-background is suppressed
			// (the user deliberately kept playback on screen; the app is logically open). The sticky flag
			// lets the "active" branch recognize an expand-back, and the PiP-stop subscription fails CLOSED
			// (locks) the moment the session ends while still backgrounded.
			//
			// DELIBERATE precedence: when a presentation AND a PiP session are both live at background, the
			// presentation branch above wins and this flag stays un-armed — a long absence then re-locks on
			// return despite the PiP session. That fails CLOSED (a prompt, never an unlocked app), and the
			// double-surface case is exotic; revisit only if it surfaces in practice.
			backgroundedDuringPipSession = true
		}
	}

	// Sticky wasBackground instead of requiring the immediately-previous state to be "background": iOS can
	// deliver background → inactive → active, which would otherwise skip this whole block.
	if (nextAppState === "active" && wasBackground) {
		wasBackground = false

		const elapsed = ctx.now - lastAppCloseTimestamp
		// A PiP-stop-induced lock moments ago is an expand-back whose stop event beat the "active" event —
		// widen the promptless window so it auto-unlocks even at the default lockAfter of 0 (mirror of the
		// presentation machinery's RELOCK_SUPPRESSION_GRACE_MS, spec §5.6.1).
		const effectiveLockAfterMs = ctx.pipStopGraceApplies ? Math.max(ctx.lockAfterMs, PIP_STOP_GRACE_MS) : ctx.lockAfterMs

		// Returned within the grace window — clear the background lock without a prompt. Beyond it (or if we
		// never locked, e.g. a suppressed picker), leave state as-is so the lock stays up and prompts.
		if (shouldAutoUnlockOnForeground(lockedByBackground, elapsed, effectiveLockAfterMs, ctx.suppressed)) {
			setAuthenticated = true
			backgroundedBehindPresentation = false
			backgroundedDuringPipSession = false
		} else if (backgroundedDuringPipSession && ctx.pipSessionActive) {
			// Expand-back with the PiP session still alive (active-before-stop order): the session extended
			// the foreground session the whole time — never re-lock here, regardless of elapsed. The stop
			// event that follows (while foreground) merely clears state.
			backgroundedDuringPipSession = false
		} else if (shouldReLockOnForeground(ctx.enabled, ctx.authenticated, elapsed, effectiveLockAfterMs, ctx.suppressed)) {
			// Background-lock was suppressed (a picker promise stayed pending the whole absence) yet we were
			// gone longer than lockAfter — fail CLOSED and re-lock now, prompting on return. Grace-inclusive
			// `suppressed` keeps a quick picker round-trip from spuriously locking.
			setAuthenticated = false
			backgroundedBehindPresentation = false
			backgroundedDuringPipSession = false
		} else if (!ctx.suppressed) {
			// Neither auto-unlock nor re-lock fired and the presentation is fully released (out of grace), so
			// the foreground decision is resolved — drop the flags. We KEEP the presentation flag only while
			// still suppressed (the picker is still pending / within grace), leaving the residual
			// presentation-end subscription to finish the fail-closed decision when activeCount finally drops
			// to 0.
			backgroundedBehindPresentation = false
			backgroundedDuringPipSession = false
		}

		lockedByBackground = false
		rekeyPrompt = true
	}

	return {
		wasBackground,
		lockedByBackground,
		backgroundedBehindPresentation,
		backgroundedDuringPipSession,
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
		logger.warn("biometric", "Biometric hardware not available or not enrolled", { hasHardware, isEnrolled })

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
	// Wrap like the Face ID prompt: prompts.input is a native dialog that resigns the app active, so without
	// this the privacy cover (which redacts on "inactive") would flash on over the PIN entry.
	const pinPromptResult = await withSystemPresentation(() =>
		prompts.input({
			title: i18n.t("pin_code"),
			message: i18n.t("enter_pin"),
			cancelText: i18n.t("cancel"),
			okText: i18n.t("authenticate"),
			inputType: "secure-text"
		})
	)

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
	try {
		await secureStore.set("biometric", {
			...biometric,
			...nextLockState(biometric)
		} satisfies TBiometric)
	} catch (e) {
		logger.warn("biometric", "Failed to persist lock-escalation state after failed auth attempt", { error: e })
	}

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
		logger.warn("biometric", "Failed to reset lock state after successful auth (best-effort)", { error: result.error })
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
			logger.error("biometric", "tryAuth failed unexpectedly", { preferBiometric, error: result.error })
			alerts.error(result.error)
		}
	}

	// Only auto-prompt while the app is actually foreground. The lock overlay ALSO mounts on
	// lock-on-background (as the app is LEAVING) — prompting there flashes the system auth sheet for a frame
	// before the OS tears it down. The foreground return re-keys this component (rekeyPrompt fires only on
	// the AppState "active" transition), remounting it while active, which is exactly when the prompt should
	// fire. (The manual "Use PIN" button remains available regardless.)
	useEffectOnce(() => {
		if (AppState.currentState !== "active") {
			return
		}

		;(async () => {
			await tryAuth(true).catch(e => logger.error("biometric", "Initial biometric prompt threw unexpectedly", { error: e }))
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
						await tryAuth(false).catch(e => logger.error("biometric", "tryAuth failed unexpectedly", { preferBiometric: false, error: e }))
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
	const backgroundedBehindPresentationRef = useRef<boolean>(false)
	const backgroundedDuringPipSessionRef = useRef<boolean>(false)
	// Timestamp of the last PiP-stop that happened while NOT active. Foreground stops are
	// deliberately not recorded: the stop-side grace exists only to absorb the stop-before-active
	// ordering on expand-back — recording foreground stops would grant an ordinary background within
	// the next PIP_STOP_GRACE_MS a spurious promptless return at lockAfter 0.
	const lastPipStopTimestampRef = useRef<number>(0)

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

	// When the user enables biometric in-session (after the fallback-password double-prompt), the feature
	// action emits this transient event. We mark THIS session as already authenticated so the imminent
	// secureStoreChange that flips enabled:true does not compute show=true and immediately throw up the lock
	// + Face ID prompt. The first real lock then happens on the next background/app-open. This MUST be an
	// explicit event, not a false→true transition of biometric.enabled: useSecureStore hydrates async, so
	// cold start ALSO produces that transition and seeding from it would defeat the lock entirely.
	useEffect(() => {
		const subscription = events.subscribe("biometricEnabledInSession", () => {
			setAuthenticated(true)
		})

		return () => {
			subscription.remove()
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
					backgroundedBehindPresentation: backgroundedBehindPresentationRef.current,
					pipSessionActive: usePipStore.getState().activeKey !== null,
					backgroundedDuringPipSession: backgroundedDuringPipSessionRef.current,
					pipStopGraceApplies: now - lastPipStopTimestampRef.current <= PIP_STOP_GRACE_MS,
					lastAppCloseTimestamp: lastAppCloseTimestampRef.current,
					now
				})

				wasBackgroundRef.current = result.wasBackground
				lockedByBackgroundRef.current = result.lockedByBackground
				backgroundedBehindPresentationRef.current = result.backgroundedBehindPresentation
				backgroundedDuringPipSessionRef.current = result.backgroundedDuringPipSession
				lastAppCloseTimestampRef.current = result.lastAppCloseTimestamp

				if (result.setAuthenticated !== null) {
					setAuthenticated(result.setAuthenticated)
				}

				if (result.rekeyPrompt) {
					setLastAppOpenTimestamp(now)
				}

				// The stop-side grace is one-shot: it exists to absorb the stop-before-active order
				// of a single expand-back. Once an "active" transition has consumed it, a LATER
				// ordinary background within the same 1.5s must not inherit the widened promptless
				// window (post-implementation review finding 5).
				if (nextAppState === "active") {
					lastPipStopTimestampRef.current = 0
				}
			})

			// Residual hardening for scenario (a): a REAL background fired while a picker was literally on screen
			// (so the lock-on-background was suppressed but backgroundedBehindPresentation got armed). On return
			// the app is already "active" (the reducer's foreground re-lock could not act — the picker was still
			// suppressing it), and the picker only dismisses afterwards — firing end() → activeCount 1->0.
			// Re-evaluate the re-lock at that moment so a long absence behind a still-open picker locks as soon as
			// the picker dismisses.
			//
			// The arbiter is the armed flag, NOT a bare elapsed > lockAfter against a stale/zero close timestamp:
			// an ordinary picker resigns the app to "inactive" (never "background"), so the flag stays false and
			// this never fires — no spurious lock on a fresh session or after a picker used long past the last
			// real background. When the flag IS armed, lastAppCloseTimestamp was stamped by that same background
			// event, so elapsed is real and a genuine long absence still fails CLOSED.
			const presentationUnsub = useSystemPresentationStore.subscribe((state, prevState) => {
				if (!(prevState.activeCount > 0 && state.activeCount === 0)) {
					return
				}

				if (AppState.currentState !== "active") {
					return
				}

				const now = Date.now()
				const elapsed = now - lastAppCloseTimestampRef.current
				const shouldReLock = shouldReLockOnPresentationEnd(
					biometricEnabledRef.current,
					authenticatedRef.current,
					backgroundedBehindPresentationRef.current,
					elapsed,
					lockAfterMsRef.current
				)

				// The presentation is fully released now — the flag has served its purpose either way, so consume
				// it so a subsequent nested-presentation end() can't re-fire against the same stale background.
				backgroundedBehindPresentationRef.current = false

				if (shouldReLock) {
					setAuthenticated(false)
					setLastAppOpenTimestamp(now)
				}
			})

			// PiP session transitions (spec: docs/pip-video-player.md §5.6.1). Mirrors the
			// presentation-end subscription above: the AppState reducer suppresses the lock while a
			// session is active; this subscription resolves the two orderings the reducer cannot see.
			const pipUnsub = usePipStore.subscribe(
				state => state.activeKey,
				(activeKey, previousActiveKey) => {
					const now = Date.now()

					// PiP-STOP.
					if (previousActiveKey !== null && activeKey === null) {
						if (AppState.currentState === "active") {
							// Expand-back, active-before-stop order: the reducer's expand-back arm
							// already resolved the session — just drop the sticky flag. No grace
							// timestamp: foreground stops must not widen a later ordinary
							// background's promptless window.
							backgroundedDuringPipSessionRef.current = false

							return
						}

						// The session ended while backgrounded (window closed, playback torn down,
						// or an expand-back whose stop event beat "active") — fail CLOSED: lock NOW
						// so the eventual return is pre-covered, and count the absence from the
						// session's end. lockedByBackground = true is what lets the "active"
						// auto-unlock clear this promptlessly within max(lockAfter,
						// PIP_STOP_GRACE_MS) — the stop-before-active expand-back case.
						lastPipStopTimestampRef.current = now
						backgroundedDuringPipSessionRef.current = false

						if (biometricEnabledRef.current && authenticatedRef.current) {
							lastAppCloseTimestampRef.current = now
							lockedByBackgroundRef.current = true
							setAuthenticated(false)
						}

						return
					}

					// PiP-START while backgrounded: auto-enter can deliver the "background" AppState
					// event BEFORE the PiP-start event, in which case the reducer locked normally
					// with nothing to un-arm it. A start arriving within a bounded window of that
					// lock is that ordering — retro-unlock and arm the sticky flag (the overlay
					// flash is unseen; the app is backgrounded). Outside the window: fail closed.
					if (previousActiveKey === null && activeKey !== null && AppState.currentState !== "active") {
						if (
							lockedByBackgroundRef.current &&
							biometricEnabledRef.current &&
							now - lastAppCloseTimestampRef.current <= PIP_START_RETRO_UNLOCK_MS
						) {
							lockedByBackgroundRef.current = false
							backgroundedDuringPipSessionRef.current = true

							setAuthenticated(true)
						}
					}
				}
			)

			defer(() => {
				appStateListener.remove()
				presentationUnsub()
				pipUnsub()
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
