export function parseHeadedFlag(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (argv.includes("--headed")) return true;
  const v = env.MKCP_HEADED;
  return v === "1" || v === "true";
}
