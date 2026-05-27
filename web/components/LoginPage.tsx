"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { LoginBackground } from "@/components/LoginBackground";
import { generateRoomSlug } from "@/lib/room-slug";
import { generatePassword } from "@/lib/crypto";
import { BUG_REPORT_URL } from "@/lib/links";
import { Bug, Lock } from "lucide-react";
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
  onJoinPrivate: (args: { password: string; create: boolean }) => void;
  /** Optional inline error from a prior failed join attempt. */
  joinError?: string | null;
};

const PRIVATE_PASSWORD_RE = /^[A-Za-z0-9_-]{22}$/;

function extractPasswordFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes("#")) {
    const frag = trimmed.split("#").pop()?.trim() ?? "";
    return PRIVATE_PASSWORD_RE.test(frag) ? frag : null;
  }
  return PRIVATE_PASSWORD_RE.test(trimmed) ? trimmed : null;
}

// Read the invite password from the URL fragment (if present) and
// validate it matches the 22-char base64url shape. Used as the lazy
// state initializer for the private-paste form so an opened invite
// link pre-fills correctly on the very first render.
function readFragmentPassword(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "").trim();
  return PRIVATE_PASSWORD_RE.test(hash) ? hash : null;
}

export function LoginPage({
  roomId,
  username,
  onRoomIdChange,
  onUsernameChange,
  onJoin,
  onJoinPrivate,
  joinError,
}: LoginPageProps) {
  const [mode, setMode] = useState<"create" | "join" | "private">(() =>
    readFragmentPassword() ? "private" : "create",
  );
  const [privateSubMode, setPrivateSubMode] = useState<"create" | "paste">(
    () => (readFragmentPassword() ? "paste" : "create"),
  );
  const [privatePassword, setPrivatePassword] = useState<string>("");
  const [privatePasted, setPrivatePasted] = useState<string>(
    () => readFragmentPassword() ?? "",
  );
  const [privatePasswordReady, setPrivatePasswordReady] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [privatePasted2, setPrivatePasted2] = useState(false);
  // LoginPage renders only after page.tsx confirms hydration, so reading
  // window in this lazy initializer is safe — no SSR mismatch risk.
  const [origin] = useState(() =>
    typeof window !== "undefined" ? window.location.origin : "",
  );

  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState(false);

  const [generatedSlug, setGeneratedSlug] = useState(
    () => roomId.trim() || generateRoomSlug(),
  );

  // Strip the fragment from the address bar after we've consumed it.
  // Keeps refreshes from re-triggering the private-paste prefill, and
  // prevents the password from showing up in screenshots / shoulder-surf.
  useEffect(() => {
    if (typeof window === "undefined" || !window.location.hash) return;
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);

  // Lazy-generate the private create-mode password the first time the user
  // lands on that subform. Subsequent clicks of "↺ new" call regen() below.
  // The empty-deps gate `if (privatePassword) return` prevents double-gen
  // when initialPrivatePassword is set.
  const generatingRef = useRef(false);
  useEffect(() => {
    if (mode !== "private" || privateSubMode !== "create") return;
    if (privatePassword || generatingRef.current) return;
    generatingRef.current = true;
    let cancelled = false;
    void generatePassword().then((p) => {
      generatingRef.current = false;
      if (cancelled) return;
      setPrivatePassword(p);
      setPrivatePasswordReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, privateSubMode, privatePassword]);

  async function regenPrivatePassword() {
    setPrivatePasswordReady(false);
    const p = await generatePassword();
    setPrivatePassword(p);
    setPrivatePasswordReady(true);
  }

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

  function handleSwitchToPrivate() {
    setMode("private");
    if (!privatePassword) setPrivateSubMode("create");
  }

  function handleCopySlug() {
    navigator.clipboard.writeText(generatedSlug);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handlePasteRoomId() {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) return;
      onRoomIdChange(trimmed);
      setPasted(true);
      setTimeout(() => setPasted(false), 1500);
    } catch {
      /* clipboard read may fail; ignore */
    }
  }

  function handleCopyInvite() {
    if (!origin || !privatePassword) return;
    navigator.clipboard.writeText(`${origin}/#${privatePassword}`);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 1500);
  }

  async function handlePastePrivate() {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) return;
      setPrivatePasted(trimmed);
      setPrivatePasted2(true);
      setTimeout(() => setPrivatePasted2(false), 1500);
    } catch {
      /* ignore */
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    if (mode === "private") {
      const password =
        privateSubMode === "create"
          ? privatePassword
          : extractPasswordFromInput(privatePasted);
      if (!password) return;
      onJoinPrivate({ password, create: privateSubMode === "create" });
      return;
    }
    const effectiveRoomId =
      mode === "create" ? roomId.trim() || generatedSlug : roomId.trim();
    if (mode === "create" && effectiveRoomId !== roomId) {
      onRoomIdChange(effectiveRoomId);
    }
    onJoin(effectiveRoomId);
  }

  const privateInputValid =
    privateSubMode === "create"
      ? Boolean(privatePassword)
      : Boolean(extractPasswordFromInput(privatePasted));

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

      <div className="relative z-10 flex min-h-0 flex-col items-center justify-center overflow-y-auto px-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1.25rem,env(safe-area-inset-top))] pb-3 sm:px-8 sm:pt-6 sm:pb-4 md:px-10 md:pt-8 lg:px-12 lg:pt-12 lg:pb-8 xl:pt-16 xl:pb-12 2xl:pt-20 2xl:pb-16">
        <div className="flex w-full max-w-md min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800/60 bg-vaux-bg-dark/70 p-6 shadow-xl shadow-black/30 backdrop-blur-md sm:max-w-lg sm:gap-4 sm:p-10 md:max-w-xl md:p-12">
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
              create
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
              join
            </button>
            <button
              type="button"
              onClick={handleSwitchToPrivate}
              className={`flex-1 flex cursor-pointer items-center justify-center gap-1 rounded-xl py-2 text-xs font-bold transition-all ${
                mode === "private"
                  ? "bg-vaux-green-dark text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Lock className="size-3" aria-hidden />
              private
            </button>
          </div>

          <form className="flex flex-col gap-3 sm:gap-4" onSubmit={handleSubmit}>
            {mode === "create" && (
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
            )}

            {mode === "join" && (
              <>
                <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-vaux-bg/90 pr-3 focus-within:border-vaux-green">
                  <input
                    className="min-w-0 flex-1 rounded-2xl bg-transparent px-3 py-3 text-base focus:outline-none sm:text-xs"
                    placeholder="room name (e.g. velvet-orbit-42)"
                    value={roomId}
                    onChange={(e) => onRoomIdChange(e.target.value)}
                    autoComplete="off"
                    autoFocus
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handlePasteRoomId}
                        className={`shrink-0 cursor-pointer text-xs transition-colors ${
                          pasted
                            ? "text-vaux-green"
                            : "text-zinc-500 hover:text-vaux-green"
                        }`}
                        aria-label="Paste room name from clipboard"
                      >
                        {pasted ? "✓ pasted" : "📋paste"}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Paste room name from clipboard
                    </TooltipContent>
                  </Tooltip>
                </div>
                {extractPasswordFromInput(roomId) && (
                  <button
                    type="button"
                    onClick={() => {
                      const pw = extractPasswordFromInput(roomId);
                      if (!pw) return;
                      setPrivatePasted(pw);
                      setMode("private");
                      setPrivateSubMode("paste");
                      onRoomIdChange("");
                    }}
                    className="cursor-pointer rounded-xl border border-vaux-green-dark bg-vaux-bg/60 px-3 py-2 text-xs text-vaux-green transition-colors hover:border-vaux-green hover:bg-vaux-green-dark/30 hover:text-vaux-light"
                  >
                    🔒 That looks like a private invite. Use it →
                  </button>
                )}
              </>
            )}

            {mode === "private" && (
              <>
                <div className="flex rounded-xl border border-zinc-700 p-1 gap-1">
                  <button
                    type="button"
                    onClick={() => setPrivateSubMode("create")}
                    className={`flex-1 cursor-pointer rounded-lg py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all ${
                      privateSubMode === "create"
                        ? "bg-vaux-green-dark/60 text-white"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    new room
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrivateSubMode("paste")}
                    className={`flex-1 cursor-pointer rounded-lg py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all ${
                      privateSubMode === "paste"
                        ? "bg-vaux-green-dark/60 text-white"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    paste invite
                  </button>
                </div>

                {privateSubMode === "create" ? (
                  <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3">
                    <span className="flex-1 truncate text-xs text-vaux-green">
                      {privatePasswordReady && origin
                        ? `${origin}/#${privatePassword}`
                        : "generating invite…"}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleCopyInvite}
                          disabled={!privatePasswordReady}
                          className={`shrink-0 cursor-pointer text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            inviteCopied
                              ? "text-vaux-green"
                              : "text-zinc-500 hover:text-vaux-green"
                          }`}
                          aria-label="Copy invite link"
                        >
                          {inviteCopied ? "✓ copied" : "📋copy"}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Copy the full invite URL
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={regenPrivatePassword}
                          disabled={!privatePasswordReady}
                          className="shrink-0 cursor-pointer text-xs text-zinc-500 transition-colors hover:text-vaux-green disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="Regenerate invite"
                        >
                          {"↺ new"}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Roll a new invite (invalidates the old one)
                      </TooltipContent>
                    </Tooltip>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-vaux-bg/90 pr-3 focus-within:border-vaux-green">
                    <input
                      className="min-w-0 flex-1 rounded-2xl bg-transparent px-3 py-3 text-base focus:outline-none sm:text-xs"
                      placeholder="paste invite link or password"
                      value={privatePasted}
                      onChange={(e) => setPrivatePasted(e.target.value)}
                      autoComplete="off"
                      autoFocus
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handlePastePrivate}
                          className={`shrink-0 cursor-pointer text-xs transition-colors ${
                            privatePasted2
                              ? "text-vaux-green"
                              : "text-zinc-500 hover:text-vaux-green"
                          }`}
                          aria-label="Paste from clipboard"
                        >
                          {privatePasted2 ? "✓ pasted" : "📋paste"}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Paste from clipboard
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </>
            )}

            <input
              className="w-full rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3 text-base focus:border-vaux-green focus:outline-none sm:text-xs"
              placeholder="your name"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              autoComplete="nickname"
              autoFocus={mode === "create"}
            />

            {joinError && (
              <p className="rounded-xl border border-[#C44545]/40 bg-[#C44545]/10 px-3 py-2 text-center text-xs text-[#FF8888]">
                {joinError}
              </p>
            )}

            <button
              type="submit"
              disabled={mode === "private" && !privateInputValid}
              className="w-full cursor-pointer rounded-2xl bg-vaux-green-dark px-4 py-3 text-sm font-bold transition-all hover:bg-vaux-green active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:py-2.5"
            >
              {mode === "create" && "create & join \u2192"}
              {mode === "join" && "join room \u2192"}
              {mode === "private" &&
                (privateSubMode === "create"
                  ? "🔒 create private room \u2192"
                  : "🔒 join private room \u2192")}
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
          {mode === "private" && privateSubMode === "create" && (
            <p className="text-center text-xs text-zinc-600">
              🔒 chat is end-to-end encrypted. Share this invite only with
              people you trust — anyone with the link can join.
            </p>
          )}
          {mode === "private" && privateSubMode === "paste" && (
            <p className="text-center text-xs text-zinc-600">
              Paste the invite link or 22-char password your friend sent.
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
          >
            Vaux on Github
          </a>
        </span>
        <span className="order-1 w-full cursor-pointer rounded-xl bg-vaux-bg px-3 py-1.5 text-center text-xs text-zinc-400 hover:bg-vaux-green hover:font-bold hover:text-black sm:order-2 sm:w-auto sm:text-zinc-500">
          <a
            href="https://itsvee0120.github.io/violet-website/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Made with <span aria-label="love">{"\u{1F497}"}</span> by Violet
          </a>
        </span>
        <span className="order-3 cursor-pointer rounded-xl bg-vaux-bg px-3 py-1.5 text-xs text-zinc-400 hover:bg-vaux-green hover:font-bold hover:text-black sm:text-zinc-500">
          <a
            href="https://pypi.org/project/vaux-cli/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Vaux on CLI via PyPI
          </a>
        </span>
      </footer>
    </main>
  );
}
