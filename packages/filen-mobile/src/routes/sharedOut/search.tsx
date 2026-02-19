import { memo } from "@/lib/memo"
import Drive from "@/components/drive"

const Search = memo(() => {
	return <Drive withSearch={true} />
})

export default Search
