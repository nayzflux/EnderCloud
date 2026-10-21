import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * `false` during server rendering and the hydration pass, `true` afterwards.
 * Use it for UI that depends on browser-only state (theme, locale, clipboard)
 * so the markup stays identical on both sides of hydration.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
