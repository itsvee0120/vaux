"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Generic over the tab id type so the parent's union (e.g. `Tab = "player" |
// "search" | ...`) flows through `activeTab` and `onChange` without any casts.
export type MobileTab<Id extends string> = {
  id: Id;
  // Short label rendered inside the active pill (icon + label).
  label: string;
  // Sentence shown in the tooltip on hover/focus. Use it to tell the user
  // what that tab actually contains, since inactive tabs are icon-only.
  description: string;
  icon: React.ReactNode;
  // Optional unread-style counter. Hidden when the tab is active (the count
  // becomes redundant once the user is already viewing it).
  badge?: number;
};

type MobileTabBarProps<Id extends string> = {
  tabs: MobileTab<Id>[];
  activeTab: Id;
  onChange: (id: Id) => void;
};

export function MobileTabBar<Id extends string>({
  tabs,
  activeTab,
  onChange,
}: MobileTabBarProps<Id>) {
  return (
    <nav className="flex shrink-0 items-center gap-1 border-t border-vaux-green-dark bg-black px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const showBadge = tab.badge != null && tab.badge > 0 && !isActive;
        return (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(tab.id)}
                // Active tab uses flex-1 so it expands to fill the remaining
                // row width and shows its label; inactive tabs shrink to a
                // bare icon pill (~40px). This produces the chip / icon-row
                // pattern from mobile player apps without any fixed widths.
                className={`relative flex cursor-pointer items-center justify-center gap-2 rounded-full px-3 py-2 text-[11px] font-medium uppercase tracking-wider transition-all duration-200 ${
                  isActive
                    ? "flex-1 bg-vaux-green text-black"
                    : "shrink-0 text-zinc-500 hover:text-zinc-300"
                }`}
                aria-label={tab.label}
                aria-pressed={isActive}
              >
                {tab.icon}
                {isActive && <span>{tab.label}</span>}
                {showBadge && (
                  <span className="absolute right-2 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-vaux-green text-[8px] font-bold text-black">
                    {tab.badge! > 9 ? "9+" : tab.badge}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            {/* Tooltip lives above the pill since the bar sits at the
                viewport bottom — `side="top"` keeps it on-screen. */}
            <TooltipContent side="top">{tab.description}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
