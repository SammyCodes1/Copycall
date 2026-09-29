"use client";
/** Follow / unfollow a trader (POST / DELETE /api/follow). Optimistic, reverts on error. */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { sendJson } from "./api";
import { Button } from "./ui/Button";
import { cn } from "./ui/cn";

export function FollowButton({
  wallet,
  initialFollowing,
  size = "md",
  className,
}: {
  wallet: string;
  initialFollowing: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !following;
    setError(null);
    setFollowing(next);
    startTransition(async () => {
      try {
        await sendJson(next ? "POST" : "DELETE", "/api/follow", { wallet });
        router.refresh();
      } catch (e) {
        setFollowing(!next);
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Button
        variant={following ? "secondary" : "primary"}
        size={size}
        onClick={toggle}
        disabled={pending}
        aria-pressed={following}
        className="min-w-[8.5rem]"
      >
        {following ? "Following" : "Follow"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-coral-400">
          {error}
        </p>
      )}
    </div>
  );
}
