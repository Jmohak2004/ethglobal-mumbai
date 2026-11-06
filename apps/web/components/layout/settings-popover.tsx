"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { clearUserZgKey, getUserZgKey, setUserZgKey } from "@/lib/user-keys";

const KEY_SHAPE = /^sk-[A-Za-z0-9_-]{8,256}$/;

/** Nav settings: paste a personal 0G key. It stays in this browser (localStorage) and is sent only to this app's AI routes. */
export function SettingsPopover() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const sync = () => setHasKey(Boolean(getUserZgKey()));
    sync();
    window.addEventListener("arena:zg-key", sync);
    return () => window.removeEventListener("arena:zg-key", sync);
  }, []);

  const save = () => {
    const key = draft.trim();
    if (!KEY_SHAPE.test(key)) {
      toast({ title: "That is not a 0G key", description: "0G keys start with sk-.", tone: "error" });
      return;
    }
    setUserZgKey(key);
    setDraft("");
    toast({ title: "Saved", description: "AI requests now bill to your 0G account.", tone: "success" });
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
        className="h-6 rounded-md border border-border px-2 text-[11px] text-muted transition-colors hover:text-text"
      >
        Settings
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-50 w-80 rounded-md border border-border bg-panel p-3 text-[12px] shadow-lg">
          <div className="font-medium">0G AI key</div>
          <p className="mt-1 text-[11.5px] text-muted">
            Stored in this browser only. Used for chart reads and share cards.
          </p>
          <div className="mt-2 text-[11.5px]">
            {hasKey ? (
              <span className="text-long">Billed to your 0G account</span>
            ) : (
              <span className="text-muted">Not set. AI uses the platform key and needs sign-in.</span>
            )}
          </div>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="0G API key"
            placeholder="sk-…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="mt-2"
          />
          <div className="mt-2 flex justify-end gap-2">
            {hasKey ? (
              <Button
                variant="ghost"
                onClick={() => {
                  clearUserZgKey();
                  toast({ title: "Key removed from this browser" });
                }}
              >
                Remove key
              </Button>
            ) : null}
            <Button variant="secondary" disabled={!draft.trim()} onClick={save}>
              Save key
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
