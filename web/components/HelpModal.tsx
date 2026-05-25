"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Each section maps to a region of the lobby UI. Order roughly follows
// top-to-bottom flow on the page so the description matches what the user
// sees as they scan. Host-only items are scoped to a single section so the
// rest of the modal stays universal — listeners can still skim "host
// controls" to understand what their host can do.
type HelpSection = {
  label: string;
  items: string[];
  hostOnly?: boolean;
};

const SECTIONS: HelpSection[] = [
  {
    label: "a big tip",
    items: [
      "Hover your mouse over the buttons and top bar to see what they do!!",
    ],
  },
  {
    label: "the room",
    items: [
      "Room name in the top bar — tap to copy & share with friends",
      "Audio may take 5–10s on first play or skip. Will sync automatically after",
    ],
  },
  {
    label: "search & queue",
    items: [
      "Search YouTube → tap a result to add it to the queue",
      "Vote ▲ to push a track up, ▼ to push it down",
      "Most-voted track plays next",
    ],
  },
  {
    label: "chat",
    items: [
      "Talk to the room's members while you listening to the music",
      "Up to 500 characters per message",
    ],
  },
  {
    label: "host controls",
    hostOnly: true,
    items: [
      "Play / pause for everyone in the room",
      "Skip to the next queue item",
      "Scrub the seek bar — all listeners follow",
      "Open the listeners panel → tap 'make host' to transfer host",
      "Remove tracks from the queue with the trash icon",
    ],
  },
  {
    label: "when things go wrong",
    items: [
      "Refresh the page — your session is restored for ~12s",
      "Browser blocked audio? Tap the green Play button when it appears",
      "Report a bug via the bug icon in the top bar",
    ],
  },
];

const LINKS = [
  { label: "GitHub", href: "https://github.com/itsvee0120/vaux" },
  { label: "PyPI (CLI)", href: "https://pypi.org/project/vaux-cli/" },
  {
    label: "About Developer",
    href: "https://itsvee0120.github.io/violet-website/",
  },
];

type HelpModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* On desktop the default max-w-lg (512px) felt cramped — bump to
          xl/2xl and add a bit more padding + section spacing so each block
          breathes. Mobile sizing (w-[95vw], default p-5) is unchanged. */}
      <DialogContent className="sm:max-w-xl lg:max-w-2xl lg:gap-4 lg:p-7">
        <DialogHeader>
          <DialogTitle className="lg:text-xl">vaux</DialogTitle>
          <DialogDescription className="lg:text-sm">
            listen together, in sync
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1 flex flex-col gap-3 lg:gap-5">
          {SECTIONS.map((section) => (
            <section key={section.label}>
              <h3 className="mb-1 flex items-center gap-2 text-xs uppercase tracking-widest text-vaux-green lg:mb-2 lg:text-sm">
                <span>{section.label}</span>
                {section.hostOnly && (
                  <span className="rounded border border-vaux-green-dark px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-vaux-green-dark lg:text-xs">
                    host only
                  </span>
                )}
              </h3>
              <ul className="flex flex-col gap-1 text-xs leading-relaxed text-vaux-light/90 lg:gap-1.5 lg:text-sm">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span
                      aria-hidden
                      className="select-none text-vaux-green-dark"
                    >
                      ·
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="mt-1 border-t border-vaux-green-dark/30 pt-3 lg:pt-4">
            <h3 className="mb-1 text-xs uppercase tracking-widest text-vaux-green lg:mb-2 lg:text-sm">
              links
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs lg:text-sm">
              {LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-vaux-green-dark underline-offset-2 hover:text-vaux-green hover:underline"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
