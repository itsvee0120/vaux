"use client";

import { useEffect, useState } from "react";
import { LoginBackground } from "@/components/LoginBackground";

// ── generateRoomSlug ──
// Generates a memorable 3-part phrase: adjective-noun-number
// e.g. "velvet-orbit-42", "cosmic-tide-17"
// Uses crypto.getRandomValues for uniform distribution across 144,000 possible slugs.
const ADJECTIVES = [
  "amber",
  "arctic",
  "azure",
  "blazing",
  "crimson",
  "crystal",
  "drifting",
  "echoing",
  "electric",
  "emerald",
  "floating",
  "frozen",
  "golden",
  "hollow",
  "indigo",
  "jade",
  "lunar",
  "mystic",
  "neon",
  "obsidian",
  "onyx",
  "opal",
  "phantom",
  "radiant",
  "rusty",
  "sacred",
  "silent",
  "silver",
  "solar",
  "spectral",
  "stellar",
  "sunken",
  "twilight",
  "velvet",
  "vibrant",
  "violet",
  "wandering",
  "wild",
  "winter",
  "wooden",
];

const NOUNS = [
  "anchor",
  "bloom",
  "canyon",
  "circuit",
  "comet",
  "current",
  "dusk",
  "ember",
  "forest",
  "harbor",
  "horizon",
  "lantern",
  "melody",
  "mirror",
  "mosaic",
  "nebula",
  "ocean",
  "orbit",
  "petal",
  "prism",
  "pulse",
  "reef",
  "relay",
  "ridge",
  "signal",
  "spark",
  "storm",
  "summit",
  "tide",
  "timber",
  "tunnel",
  "valley",
  "vinyl",
  "vortex",
  "wave",
  "willow",
  "wind",
  "wraith",
  "zenith",
  "zephyr",
];

function generateRoomSlug(): string {
  // crypto.getRandomValues gives better entropy than Math.random
  const buf = new Uint32Array(3);
  crypto.getRandomValues(buf);

  const adj = ADJECTIVES[buf[0] % ADJECTIVES.length];
  const noun = NOUNS[buf[1] % NOUNS.length];
  // Two-digit suffix (10–99) multiplies the space 90x without hurting readability
  const suffix = 10 + (buf[2] % 90);

  return `${adj}-${noun}-${suffix}`;
}

type LoginPageProps = {
  roomId: string;
  username: string;
  onRoomIdChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onJoin: () => void;
};

export function LoginPage({
  roomId,
  username,
  onRoomIdChange,
  onUsernameChange,
  onJoin,
}: LoginPageProps) {
  // Track which tab the user is on — "create" generates a slug, "join" is free-type
  const [mode, setMode] = useState<"create" | "join">("create");

  // Slug is generated client-side only to avoid SSR hydration mismatches.
  const [generatedSlug, setGeneratedSlug] = useState("");

  useEffect(() => {
    if (mode !== "create" || generatedSlug) return;
    const slug = roomId.trim() || generateRoomSlug();
    setGeneratedSlug(slug);
    if (!roomId.trim()) onRoomIdChange(slug);
  }, [mode, roomId, generatedSlug, onRoomIdChange]);

  function handleCreate() {
    // Generate a fresh slug, sync it both locally and up to the parent
    const slug = generateRoomSlug();
    setGeneratedSlug(slug);
    onRoomIdChange(slug);
    setMode("create");
  }

  function handleSwitchToJoin() {
    // Clear the parent's roomId so the join input starts empty
    onRoomIdChange("");
    setMode("join");
  }

  function handleSwitchToCreate() {
    // Re-generate when switching back so they always get a fresh one
    const slug = generateRoomSlug();
    setGeneratedSlug(slug);
    onRoomIdChange(slug);
    setMode("create");
  }

  return (
    <main className="relative isolate grid min-h-dvh w-full min-w-0 grid-rows-[1fr_auto] overflow-x-hidden bg-vaux-bg-dark font-mono text-white box-border">
      <LoginBackground />

      <div className="relative z-10 flex min-h-0 flex-col items-center justify-center overflow-y-auto px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1.25rem,env(safe-area-inset-top))] pb-3 sm:px-8 sm:pt-6 sm:pb-4 md:px-10 md:pt-8 lg:px-12">
        <div className="flex w-full max-w-[17.5rem] min-w-0 flex-col gap-3 sm:max-w-xs sm:gap-4 md:max-w-sm">
          <header className="text-center sm:text-left">
            <h1 className="font-bold leading-[0.95] tracking-tight text-vaux-green text-[clamp(2.5rem,14vw,4.75rem)] sm:text-[clamp(2.75rem,12vw,5rem)]">
              VAUX
            </h1>
            <p className="mt-1 text-xs text-zinc-500 sm:text-sm">
              listen together, in sync
            </p>
          </header>

          {/* ── mode toggle ── */}
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
              onJoin();
            }}
          >
            {mode === "create" ? (
              // ── create mode: show generated slug with a re-roll button ──
              <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3">
                <span className="flex-1 truncate text-base text-vaux-green sm:text-sm">
                  {generatedSlug || "…"}
                </span>
                <button
                  type="button"
                  onClick={handleCreate}
                  className="shrink-0 cursor-pointer text-xs text-zinc-500 hover:text-vaux-green transition-colors"
                  title="Generate a new name"
                >
                  {"↺ new"}
                </button>
              </div>
            ) : (
              // ── join mode: free-type the room name a host shared ──
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
            />

            <button
              type="submit"
              className="w-full cursor-pointer rounded-2xl bg-vaux-green-dark px-4 py-3 text-sm font-bold transition-all hover:bg-vaux-green active:scale-95 sm:py-2.5"
            >
              {mode === "create" ? "create & join \u2192" : "join room \u2192"}
            </button>
          </form>

          {/* ── hint so joiners know what to ask the host for ── */}
          {mode === "join" && (
            <p className="text-center text-xs text-zinc-600">
              ask the host for their room name
            </p>
          )}
        </div>
      </div>

      <footer className="relative z-30 flex shrink-0 justify-center border-t border-zinc-800/40 bg-vaux-bg-dark/95 px-[max(1rem,env(safe-area-inset-left))] py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:py-3">
        <span className="rounded-xl bg-vaux-bg px-3 py-1.5 text-xs text-zinc-400 sm:text-zinc-500">
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
      </footer>
    </main>
  );
}
