/** Shapes passed from server code to components (no server-only imports). */
import type { Phase, Side } from "./schemas";

export type StreakResult = "W" | "L";

export type LeaderRow = {
  rank: number;
  wallet: string;
  resolvedCalls: number;
  correctCalls: number;
  hitRate: number;
  openPositions: number;
  lastActive: number | null;
  creatorTradeCount: number;
  creatorVerified: boolean;
  streak: StreakResult[];
};

export type TapeItem = {
  signature: string;
  wallet: string;
  side: Side;
  shares: string;
  title: string;
  blockTime: number | null;
  isCreatorTrade: boolean;
};

export type ProfileTrade = {
  id: string;
  title: string;
  side: Side;
  shares: string;
  blockTime: number | null;
  isPrimary: boolean;
  isCreatorTrade: boolean;
  creatorVerified: boolean;
  marketStatus: Phase | null;
};

export type ProfilePosition = {
  marketId: string;
  title: string;
  side: Side;
  shares: string;
  phase: Phase;
};

export type TraderProfile = {
  wallet: string;
  stats: LeaderRow | null; // rank 0 = not ranked
  minResolved: number;
  trades: ProfileTrade[];
  openPositions: ProfilePosition[];
  updatedAt: number | null;
};
