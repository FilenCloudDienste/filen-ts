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
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Circle } from "react-native-svg"

const LOCK_MULTIPLIER_INITIAL = 1
const LOCK_MULTIPLIER_MAX_SECONDS = 3600
const LOCK_BASE_MS = 1000

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

	return await LocalAuthentication.authenticateAsync({
		cancelLabel: i18n.t("cancel"),
		promptMessage: i18n.t("authenticate"),
		promptDescription: i18n.t("authenticate_to_access_app"),
		promptSubtitle: "",
		disableDeviceFallback: true,
		fallbackLabel: i18n.t("use_pin")
	})
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
	await secureStore.set("biometric", {
		...biometric,
		lockedMultiplier: LOCK_MULTIPLIER_INITIAL,
		lockedUntil: 0
	} satisfies TBiometric)

	onSuccess()
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
				const ms = Math.max(0, lockedUntil - Date.now())

				if (ms <= 0) {
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
	const lastAppStateRef = useRef<AppStateStatus>(AppState.currentState)
	const lockAfterMsRef = useRef<number>(biometric.enabled ? biometric.lockAfter * LOCK_BASE_MS : 0)

	useEffect(() => {
		lockAfterMsRef.current = biometric.enabled ? biometric.lockAfter * LOCK_BASE_MS : 0
	}, [biometric])

	const show = biometric.enabled && !authenticated
	const locked = biometric.enabled && new Date().getTime() < biometric.lockedUntil

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
				if (nextAppState === "background") {
					lastAppCloseTimestampRef.current = Date.now()
				}

				if (nextAppState === "active" && lastAppStateRef.current === "background") {
					const elapsed = Date.now() - lastAppCloseTimestampRef.current

					if (elapsed > lockAfterMsRef.current) {
						setAuthenticated(false)
					}

					setLastAppOpenTimestamp(Date.now())
				}

				lastAppStateRef.current = nextAppState
			})

			defer(() => {
				appStateListener.remove()
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
