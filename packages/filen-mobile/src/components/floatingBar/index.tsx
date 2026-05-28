import { Fragment, memo } from "react"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useAudio } from "@/lib/audio"
import useTransfersStore from "@/stores/useTransfers.store"
import useFloatingBarOffset from "@/hooks/useFloatingBarOffset"
import AudioSlot from "@/components/floatingBar/audioSlot"
import TransfersSlot from "@/components/floatingBar/transfersSlot"
import Separator from "@/components/floatingBar/separator"

const FloatingBar = memo(() => {
	const insets = useSafeAreaInsets()
	const offset = useFloatingBarOffset()
	const { queueItem } = useAudio()
	const transfersActive = useTransfersStore(useShallow(state => state.transfers.length > 0))

	const audioActive = queueItem !== null

	if (!audioActive && !transfersActive) {
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
