"use client";

import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";

import { useColorTheme } from "@/components/tradingview/use-color-theme";

/** Script name under https://s3.tradingview.com/external-embedding/embed-widget-<name>.js */
export type TvWidgetName = "ticker-tape" | "crypto-coins-heatmap" | "timeline";

/**
 * Renders one TradingView embed widget. The widget script reads its JSON config from its own text, so the script tag is
 * injected into the container in an effect and removed in the cleanup (StrictMode's double mount and theme or config
 * changes therefore never leave two widgets behind). colorTheme follows the app theme. With `lazy` the script is only
 * injected once the container is near the viewport. The caller sets the height through `className`.
 */
export function TvWidget({
  widget,
  config,
  lazy = false,
  className,
  label,
}: {
  widget: TvWidgetName;
  config: Record<string, unknown>;
  lazy?: boolean;
  className?: string;
  label: string;
}) {
  const theme = useColorTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const configKey = JSON.stringify(config);

  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!visible || !host) return;
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget h-full w-full";
    const script = document.createElement("script");
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${widget}.js`;
    script.async = true;
    script.type = "text/javascript";
    script.text = JSON.stringify({
      width: "100%",
      height: "100%",
      ...JSON.parse(configKey),
      colorTheme: theme,
      isTransparent: true,
      locale: "en",
    });
    host.replaceChildren(inner, script);
    return () => host.replaceChildren();
  }, [visible, widget, configKey, theme]);

  // The widget writes inline width/height onto its container, so the container fills a sized wrapper instead of being sized itself.
  return (
    <div role="region" aria-label={label} className={clsx("min-w-0 overflow-hidden", className)}>
      <div ref={hostRef} className="tradingview-widget-container h-full w-full" />
    </div>
  );
}
