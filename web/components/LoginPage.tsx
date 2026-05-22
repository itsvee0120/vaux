import { LoginBackground } from "@/components/LoginBackground";

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
          <form
            className="flex flex-col gap-3 sm:gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onJoin();
            }}
          >
            <input
              className="w-full rounded-2xl border border-zinc-700 bg-vaux-bg/90 px-3 py-3 text-base focus:border-vaux-green focus:outline-none sm:text-sm"
              placeholder="room name (e.g. indie-night)"
              value={roomId}
              onChange={(e) => onRoomIdChange(e.target.value)}
              autoComplete="off"
            />
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
              join room →
            </button>
          </form>
        </div>
      </div>

      <footer className="relative z-30 flex shrink-0 justify-center border-t border-zinc-800/40 bg-vaux-bg-dark/95 px-[max(1rem,env(safe-area-inset-left))] py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:py-3">
        <span className="rounded-xl bg-vaux-bg px-3 py-1.5 text-xs text-zinc-400 sm:text-zinc-500">
          Made with 💗 by{" "}
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
