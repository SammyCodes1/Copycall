import { Tag } from "./ui/Badge";

/**
 * Creator flag (hard requirement 5): the trader created the market they traded.
 * `verified=false` = creator inferred from the market's create-tx fee payer and
 * not yet confirmed, and the tag says "unverified".
 */
export function CreatorFlag({ count, verified, className }: { count?: number; verified: boolean; className?: string }) {
  return (
    <Tag tone="amber" className={className}>
      <svg aria-hidden="true" viewBox="0 0 8 8" className="size-2 fill-current">
        <path d="M4 0 8 4 4 8 0 4Z" />
      </svg>
      <span>Own market{count && count > 1 ? ` ×${count}` : ""}</span>
      {!verified && <span className="text-amber-300/80">· unverified</span>}
      <span className="sr-only">
        {verified
          ? "This trader created the market they traded."
          : "Creator inferred from the market's create transaction, not yet verified."}
      </span>
    </Tag>
  );
}
