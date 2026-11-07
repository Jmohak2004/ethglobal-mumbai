"use client";

import { useSyncExternalStore } from "react";

export type ColorTheme = "light" | "dark";

/** The app theme lives on <html>: a `dark` class, a data-theme attribute, or the CSS color-scheme. Light is the default. */
function read(): ColorTheme {
  const el = document.documentElement;
  if (el.classList.contains("dark") || el.dataset.theme === "dark") return "dark";
  if (el.classList.contains("light") || el.dataset.theme === "light") return "light";
  return el.style.colorScheme === "dark" || getComputedStyle(el).colorScheme.trim() === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  return () => mo.disconnect();
}

/** Current app theme, re-evaluated whenever <html> changes. Server and first client render report "light". */
export function useColorTheme(): ColorTheme {
  return useSyncExternalStore(subscribe, read, () => "light");
}
