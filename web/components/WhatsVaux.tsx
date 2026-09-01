"use client";

import { useState } from "react";
import Image from "next/image";
import { Share2 } from "lucide-react";
import vauxQr from "@/assets/share_vaux.png";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function WhatsVaux() {
  const [shared, setShared] = useState(false);

  async function handleShare() {
    const shareData = {
      title: "Vaux",
      text: "Listen to music together, in sync — join me on Vaux.",
      url: typeof window !== "undefined" ? window.location.origin : "",
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        /* user cancelled the share sheet; ignore */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      setShared(true);
      setTimeout(() => setShared(false), 1500);
    } catch {
      /* clipboard unavailable*/
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 cursor-pointer rounded-xl bg-vaux-bg/90 px-3 py-1.5 text-xs text-zinc-400 backdrop-blur-sm transition-colors hover:bg-vaux-green hover:font-bold hover:text-black"
          aria-label="What's Vaux?"
        >
          what&apos;s vaux
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-3">
          <p className="font-bold text-vaux-green">VAUX</p>
          <p className="text-sm leading-relaxed text-zinc-500">
            Vaux is a listen-together room: queue up YouTube tracks, chat, and
            stay in perfect sync with friends — no matter where everyone is.
            Create a room, share the link, and hit play.
          </p>

          <div className="flex flex-col items-center gap-2 rounded-2xl border border-vaux-green-dark/60 p-3">
            <Image
              src={vauxQr}
              alt="QR code to open Vaux"
              className="size-32 rounded-lg bg-white p-1"
            />
            <span className="text-[10px] text-zinc-500">
              scan to open on another device
            </span>
          </div>

          <button
            type="button"
            onClick={handleShare}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-vaux-green-dark px-4 py-2.5 text-sm font-bold text-white transition-all hover:bg-vaux-green active:scale-95"
          >
            <Share2 className="size-4" aria-hidden />
            {shared ? "✓ link copied" : "share with friends"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
