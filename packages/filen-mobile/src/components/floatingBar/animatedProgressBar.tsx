import useTransfersStore from "@/features/transfers/store/useTransfers.store"
import ProgressBar, { useProgressValue } from "@/components/floatingBar/progressBar"

// Outside the component: the React Compiler skips a component that references a hook as a value.
function currentProgress(): number {
	return useTransfersStore.getState().stats.progress
}

function subscribeProgress(onNext: (next: number) => void): () => void {
	return useTransfersStore.subscribe(state => {
		onNext(state.stats.progress)
	})
}

const AnimatedProgressBar = () => {
	const progress = useProgressValue(currentProgress(), subscribeProgress)

	return <ProgressBar progress={progress} />
}

export default AnimatedProgressBar
