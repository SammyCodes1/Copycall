export function Footer() {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto grid max-w-[76rem] gap-4 px-4 py-8 sm:grid-cols-[1fr_auto] sm:items-end sm:px-6">
        <div className="space-y-2">
          <a
            href="https://panta.market"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand-300"
          >
            Powered by Panta
          </a>
          <p className="max-w-md text-sm text-fg-subtle">
            Copycall never holds your funds or keys. Every copy is reviewed and signed by your own wallet. Not financial
            advice.
          </p>
        </div>
        <p className="label text-fg-subtle">MIT · 2026 · Copycall</p>
      </div>
    </footer>
  );
}
