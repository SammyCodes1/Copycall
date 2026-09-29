import type { Metadata, Viewport } from "next";
import { Instrument_Serif, JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { MockBanner } from "@/components/MockBanner";
import { WalletProviders } from "@/components/WalletProviders";
import { getSession } from "@/lib/auth";
import { isMockMode } from "@/lib/env";
import "./globals.css";

// Type system (all SIL Open Font License 1.1, self-hosted at build by next/font,
// so the CSP's font-src 'self' holds; no Google Fonts CDN at runtime):
//  - Instrument Serif: editorial display face with character (headlines only)
//  - Schibsted Grotesk: precise grotesk for UI and body
//  - JetBrains Mono: tabular numerals, addresses, labels
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

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
        <div className="ground" aria-hidden />
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
