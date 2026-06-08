// Stub: Cursor OAuth is not available in the embedded Kanban build.
export async function refreshCursorToken(_refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }> {
	throw new Error("Cursor OAuth is not available in this build");
}

export async function loginCursor(
	_openBrowser: (url: string) => void,
	_onProgress?: () => void,
): Promise<{ accessToken: string; refreshToken?: string }> {
	throw new Error("Cursor OAuth login is not available in this build");
}
