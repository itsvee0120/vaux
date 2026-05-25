"use client";

import { useState } from "react";
import { LoginBackground } from "@/components/LoginBackground";
import { generateRoomSlug } from "@/lib/room-slug";
import { BUG_REPORT_URL } from "@/lib/links";
import { Bug } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type LoginPageProps = {
  roomId: string;
  username: string;
  onRoomIdChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onJoin: (roomIdOverride?: string) => void;
};

export function LoginPage({
  roomId,
  username,
  onRoomIdChange,
  onUsernameChange,
  onJoin,
}: LoginPageProps) {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [copied, setCopied] = useState(false);

  const [generatedSlug, setGeneratedSlug] = useState(
    () => roomId.trim() || generateRoomSlug(),
  );

  function handleCreate() {
    const slug = generateRoomSlug();
    setGeneratedSlug(slug);
    onRoomIdChange(slug);
    setMode("create");
  }

  function handleSwitchToJoin() {
    onRoomIdChange("");
    setMode("join");
  }

  function handleSwitchToCreate() {
    const slug = generateRoomSlug();
    setGeneratedSlug(slug);
    onRoomIdChange(slug);
    setMode("create");
  }

  function handleCopySlug() {
    navigator.clipboard.writeText(generatedSlug);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="relative isolate grid min-h-dvh w-full min-w-0 grid-rows-[1fr_auto] overflow-x-hidden bg-vaux-bg-dark font-mono text-white box-border">
      <LoginBackground />

      {BUG_REPORT_URL && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={BUG_REPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex cursor-pointer items-center gap-1.5 rounded-xl bg-vaux-bg/90 px-3 py-1.5 text-xs text-zinc-400 backdrop-blur-sm transition-colors hover:bg-vaux-green hover:font-bold hover:text-black"
              aria-label="Report a bug"
            >
              <Bug className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">report bug</span>
            </a>
          </TooltipTrigger>
          <TooltipContent side="left">
            Report a bug or request a feature
          </TooltipContent>
        </Tooltip>
      )}

      <div className="relative z-10 flex min-h-0 flex-col items-center justify-center overflow-y-auto px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1.25rem,env(safe-area-inset-top))] pb-3 sm:px-8 sm:pt-6 sm:pb-4 md:px-10 md:pt-8 lg:px-12">
        <div className="flex w-full max-w-[17.5rem] min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800/60 bg-vaux-bg-dark/70 p-4 shadow-xl shadow-black/30 backdrop-blur-md sm:max-w-xs sm:gap-4 sm:p-5 md:max-w-sm md:p-6">
          <header className="text-center sm:text-left">
            <h1 className="font-bold leading-[0.95] tracking-tight text-vaux-green text-[clamp(2.5rem,14vw,4.75rem)] sm:text-[clamp(2.75rem,12vw,5rem)]">
              VAUX
            </h1>
            <p className="mt-1 text-xs text-zinc-500 sm:text-sm">
              listen together, in sync
            </p>
          </header>

          <div className="flex rounded-2xl border border-zinc-700 p-1 gap-1">
            <button
              type="button"
              onClick={handleSwitchToCreate}
              className={`flex-1 cursor-pointer rounded-xl py-2 text-xs font-bold transition-all ${
                mode === "create"
                  ? "bg-vaux-green-dark text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              create room
            </button>
            <button
              type="button"
              onClick={handleSwitchToJoin}
              className={`flex-1 cursor-pointer rounded-xl py-2 text-xs font-bold transition-all ${
                mode === "join"
                  ? "bg-vaux-green-dark text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              join room
            </button>
          </div>

          <form
            className="flex flex-col gap-3 sm:gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const effectiveRoomId =
                mode === "create"
                  ? roomId.trim() || generatedSlug
                  : roomId.trim();
              if (mode === "create" && effectiveRoomId !== roomId) {
                onRoomIdChange(effectiveRoomId);
              }
              onJoin(effectiveRoomId);
            }}
          >
            {mode === "create" ? (
              <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3">
                <span className="flex-1 truncate text-base text-vaux-green sm:text-sm">
                  {generatedSlug || "…"}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopySlug}
                      className={`shrink-0 cursor-pointer text-xs transition-colors ${
                        copied
                          ? "text-vaux-green"
                          : "text-zinc-500 hover:text-vaux-green"
                      }`}
                      aria-label="Copy room name"
                    >
                      {copied ? "✓ copied" : "📋copy"}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Copy room name to share with others
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCreate}
                      className="shrink-0 cursor-pointer text-xs text-zinc-500 hover:text-vaux-green transition-colors"
                      aria-label="Generate a new room name"
                    >
                      {"↺ new"}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Roll a new room name
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <input
                className="w-full rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3 text-base focus:border-vaux-green focus:outline-none sm:text-sm"
                placeholder="room name (e.g. velvet-orbit-42)"
                value={roomId}
                onChange={(e) => onRoomIdChange(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            )}

            <input
              className="w-full rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3 text-base focus:border-vaux-green focus:outline-none sm:text-sm"
              placeholder="your name"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              autoComplete="nickname"
              autoFocus={mode === "create"}
            />

            <button
              type="submit"
              className="w-full cursor-pointer rounded-2xl bg-vaux-green-dark px-4 py-3 text-sm font-bold transition-all hover:bg-vaux-green active:scale-95 sm:py-2.5"
            >
              {mode === "create" ? "create & join \u2192" : "join room \u2192"}
            </button>
          </form>

          {mode === "join" && (
            <p className="text-center text-xs text-zinc-600">
              Ask the host for their room name
            </p>
          )}
          {mode === "create" && (
            <p className="text-center text-xs text-zinc-600">
              Copy the room name to share with others.
            </p>
          )}
        </div>
      </div>

      <footer className="relative z-30 flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-zinc-800/40 bg-vaux-bg-dark/95 px-[max(0.75rem,env(safe-area-inset-left))] py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pr-[max(0.75rem,env(safe-area-inset-right))] backdrop-blur-sm sm:flex-nowrap sm:justify-between sm:py-3">
        <span className="order-2 cursor-pointer rounded-xl bg-vaux-bg px-3 py-1.5 text-xs text-zinc-400 hover:bg-vaux-green hover:font-bold hover:text-black sm:order-1 sm:text-zinc-500">
          <a
            href="https://github.com/itsvee0120/vaux"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Vaux on Github
          </a>
        </span>
        <span className="order-1 w-full rounded-xl bg-vaux-bg px-3 py-1.5 text-center text-xs text-zinc-400 sm:order-2 sm:w-auto sm:text-zinc-500">
          Made with <span aria-label="love">{"\u{1F497}"}</span>
          {" by "}
          <a
            href="https://itsvee0120.github.io/violet-website/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-vaux-green"
          >
            Vee
          </a>
        </span>
        <span className="order-3 cursor-pointer rounded-xl bg-vaux-bg px-3 py-1.5 text-xs text-zinc-400 hover:bg-vaux-green hover:font-bold hover:text-black sm:text-zinc-500">
          <a
            href="https://pypi.org/project/vaux-cli/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Vaux on CLI via PyPI
          </a>
        </span>
      </footer>
    </main>
  );
}
