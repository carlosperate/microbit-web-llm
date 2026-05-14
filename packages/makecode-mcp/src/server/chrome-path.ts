export interface ChromePathOptions {
  env: Readonly<Record<string, string | undefined>>;
  findSystemChrome: () => string | undefined;
}

// MCPB passes unset optional `user_config` fields through as the literal
// template string (e.g. "${user_config.chrome_path}"). Treat anything still
// containing a "${...}" placeholder as unset.
const UNSUBSTITUTED_TEMPLATE = /\$\{[^}]*\}/;

export function resolveChromePath({
  env,
  findSystemChrome,
}: ChromePathOptions): string {
  const raw = env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const fromEnv = raw && !UNSUBSTITUTED_TEMPLATE.test(raw) ? raw : undefined;
  if (fromEnv) return fromEnv;
  let found: string | undefined;
  try {
    found = findSystemChrome();
  } catch {
    found = undefined;
  }
  if (found) return found;
  throw new Error(
    "Could not locate Chrome on this system. Install Google Chrome (or Chromium) " +
      "or set PUPPETEER_EXECUTABLE_PATH to the browser binary.",
  );
}
