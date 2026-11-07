"use client";

import { Menu } from "@/components/ui/menu";
import { IconDots } from "@/components/ui/icons";
import { DemoMenu } from "@/components/layout/demo-menu";
import { SettingsPopover } from "@/components/layout/settings-popover";
import { CHAIN } from "@/lib/contracts";

/** The "..." menu: settings (bring your own AI key), demo controls (when the server enables them) and the network. */
export function MoreMenu() {
  return (
    <Menu label="More: settings and demo controls" trigger={<IconDots size={18} />} width="w-[22rem] max-w-[calc(100vw-2rem)]">
      <div className="p-2.5">
        <SettingsPopover />
        <DemoMenu />
        <div
          className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted"
          title={`Chain from NEXT_PUBLIC_CHAIN: ${CHAIN.name} (chain id ${CHAIN.id})`}
        >
          <span>Network</span>
          <span className="num inline-flex items-center gap-1.5 text-text-2">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            {CHAIN.name}
          </span>
        </div>
      </div>
    </Menu>
  );
}
