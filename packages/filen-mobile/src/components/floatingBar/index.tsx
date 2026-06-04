import { Fragment, memo } from "react"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useAudio } from "@/features/audio/audio"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import useFloatingBarOffset from "@/hooks/useFloatingBarOffset"
import AudioSlot from "@/components/floatingBar/audioSlot"
import TransfersSlot from "@/components/floatingBar/transfersSlot"
import Separator from "@/components/floatingBar/separator"
import useAppStore from "@/stores/useApp.store"

const FloatingBar = memo(() => {
	const insets = useSafeAreaInsets()
	const offset = useFloatingBarOffset()
	const { queueItem } = useAudio()
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.length > 0))
	// FloatingBar is mounted at the root _layout as a sibling of <Stack/>, not
	// inside any specific route. The "pathname tracks focused URL not mount
	// point" gotcha that bit us with drive header's left button does NOT apply
	// here — we WANT the focused URL, because the bar is a global overlay and
	// its visibility is supposed to track wherever the user currently is.
	//
	// On iOS, modal screens are pageSheet and the OS chrome naturally covers
	// the bar. On Android modals use the same plane as the bar, and on both
	// platforms non-tab stack pushes (/chat/[uuid], /note/[uuid]) never cover
	// it. Gate on the focused route so the bar only ever shows inside /tabs.
	const isOnTabs = useAppStore(state => state.pathname.startsWith("/tabs"))

	const audioActive = queueItem !== null

	if (!isOnTabs || (!audioActive && !transfersActive)) {
		return null
	}

	return (
		<View
			pointerEvents="box-none"
			className="absolute left-0 right-0 bg-transparent"
			style={{
				bottom: offset,
				paddingLeft: insets.left > 0 ? insets.left : 16,
				paddingRight: insets.right > 0 ? insets.right : 16
			}}
		>
			<CrossGlassContainerView className="overflow-hidden flex-row items-stretch min-h-11">
				{audioActive ? (
					<View className="flex-1 bg-transparent">
						<AudioSlot />
					</View>
				) : (
					<Fragment />
				)}
				{audioActive && transfersActive ? <Separator /> : <Fragment />}
				{transfersActive ? (
					<View className="flex-1 bg-transparent">
						<TransfersSlot />
					</View>
				) : (
					<Fragment />
				)}
			</CrossGlassContainerView>
		</View>
	)
})

export default FloatingBar
