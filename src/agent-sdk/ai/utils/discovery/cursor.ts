// Stub: Cursor model discovery is not available in the embedded Kanban build.
export async function fetchCursorUsableModels(_options: {
	apiKey: string;
	baseUrl?: string;
	clientVersion?: string;
}): Promise<Array<{ id: string; name: string }>> {
	throw new Error("Cursor model discovery is not available in this build");
}
