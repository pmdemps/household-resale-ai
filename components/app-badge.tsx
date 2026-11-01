"use client";

import { useEffect } from "react";

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/**
 * Keeps the number on the home-screen app icon equal to the to-dos waiting on us (the same count as the
 * Offers tab). Only does anything where the Badging API exists: iPhone home-screen apps with notifications
 * allowed, installed desktop apps. Push notifications set it too (public/sw.js).
 */
export function AppBadge({ count }: { count: number }) {
  useEffect(() => {
    const nav = navigator as BadgeNavigator;
    try {
      const pending = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
      pending?.catch(() => undefined);
    } catch {
      // Not supported here.
    }
  }, [count]);
  return null;
}
