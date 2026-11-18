// Stands in for elkjs in the diagram frame's script. The frame's configuration fixes the dagre layout and a diagram can
// set none, so mermaid never loads ELK; leaving it out keeps ~1.4 MB of script from every frame's start.
export default class Elk {
	public layout(): Promise<never> {
		return Promise.reject(new Error("the ELK layout is not part of the diagram frame"))
	}
}
