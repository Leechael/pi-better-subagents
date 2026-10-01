export interface NativeManagerOptions {
  platform?: string;
  arch?: string;
  /** Node package resolver; tests can use createRequire from an isolated consumer. */
  resolve?: (specifier: string) => string;
}
export function nativePackageName(platform: string, arch: string): string | null;
/** Null when unsupported, missing, corrupt, non-executable, or a different version. */
export function resolveNativeManagerPath(options?: NativeManagerOptions): string | null;
