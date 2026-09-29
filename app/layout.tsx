import type { Metadata, Viewport } from "next";
import { Figtree, Funnel_Display, Geist_Mono } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { MockBanner } from "@/components/MockBanner";
import { WalletProviders } from "@/components/WalletProviders";
import { getSession } from "@/lib/auth";
import { isMockMode } from "@/lib/env";
import "./globals.css";

// Display + sans pairing (same families Panta's site uses: Funnel Display for
// display, Figtree for UI), self-hosted by next/font. Geist Mono for addresses.
const display = Funnel_Display({ subsets: ["latin"], variable: "--font-funnel-display", display: "swap" });
const sans = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Copycall · Copy the sharpest Panta callers",
  description:
    "Rank Panta prediction-market traders by hit rate, follow the best, and copy their calls in one tap. Always signed by your own wallet.",
};

export const viewport: Viewport = {
  themeColor: "#0b0d0f",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const mock = isMockMode();
  const session = await getSession();
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <div className="bg-mesh" aria-hidden />
        <WalletProviders>
          {mock && <MockBanner />}
          <Header sessionWallet={session?.w ?? null} />
          <main className="flex-1 overflow-x-clip">{children}</main>
          <Footer />
        </WalletProviders>
      </body>
    </html>
  );
}
