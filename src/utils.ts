export const bad = (error: string, status = 400): Response =>
	Response.json({ ok: false, error }, { status });

export const enc = new TextEncoder();

const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

export function b64urlDecodeUtf8(str: string): string {
	const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return dec.decode(bytes);
}

export async function sha256Short(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));

	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

export async function hmac(text: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

export function readCookie(request: Request, name: string): string | null {
	const raw = request.headers.get("cookie") || "";

	for (const part of raw.split(";")) {
		const [k, ...v] = part.trim().split("=");

		if (k === name) {
			return v.join("=");
		}
	}

	return null;
}