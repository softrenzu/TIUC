export type AppEnv = Env & {
	AUTH_SECRET: string;
	HASH_SALT?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
};

export type CookieAttrs = "" | "; Secure";
