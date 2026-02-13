import { memo } from "@/lib/memo"
import Drive from "@/components/drive"

const SharedOut = memo(() => {
	return <Drive />
})

export default SharedOut
