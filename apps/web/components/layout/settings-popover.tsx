"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { clearUserZgKey, getUserZgKey, setUserZgKey } from "@/lib/user-keys";

const KEY_SHAPE = /^sk-[A-Za-z0-9_-]{8,256}$/;

/** Body of the settings section in the nav "more" menu: paste a personal 0G key. It stays in this browser (localStorage) and is sent only to this app's AI routes. */
export function SettingsPopover() {
  const toast = useToast();
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
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-base font-medium">Your own 0G AI key</div>
        <p className="mt-0.5 text-xs text-muted">
          Optional. Stored only in this browser and used for chart reads and share cards. Without one, AI uses the platform key and needs sign-in.
        </p>
      </div>
      <div className="text-xs">
        {hasKey ? <span className="font-medium text-long">Using your 0G account</span> : <span className="text-muted">Not set</span>}
      </div>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="0G API key"
        placeholder="sk-…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        {hasKey ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearUserZgKey();
              toast({ title: "Key removed from this browser" });
            }}
          >
            Remove key
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" disabled={!draft.trim()} onClick={save}>
          Save key
        </Button>
      </div>
    </div>
  );
}
