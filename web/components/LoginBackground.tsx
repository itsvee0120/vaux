import Image from "next/image";
import bgLanding from "@/assets/bg-landing.webp";

const handSize =
  "h-[min(50dvh,22rem)] w-[min(72vw,20rem)] max-[380px]:h-[min(42dvh,18rem)] max-[380px]:w-[min(68vw,17rem)] sm:h-[min(56dvh,26rem)] sm:w-[min(58vw,22rem)] md:h-[min(60dvh,30rem)] md:w-[min(44vw,26rem)] lg:h-[min(72dvh,42rem)] lg:w-[min(44rem,48vw)] xl:h-[min(78dvh,48rem)] xl:w-[min(52rem,52vw)]";

function CornerHand({
  flip,
  className = "",
}: {
  flip?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`absolute ${flip ? "rotate-180" : ""} ${handSize} ${className}`}
    >
      <Image
        src={bgLanding}
        alt=""
        fill
        priority
        sizes="(max-width: 1024px) 72vw, 52rem"
        quality={80}
        className="object-contain object-left-bottom"
      />
    </div>
  );
}

export function LoginBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <CornerHand className="bottom-8 left-0 sm:bottom-12 md:bottom-16 lg:bottom-15" />
      <CornerHand flip className="right-0 top-0 hidden sm:block" />
    </div>
  );
}
