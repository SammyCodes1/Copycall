export function Footer() {
  return (
    <footer className="mt-auto border-t border-white/[0.06]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-fg-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <a
            href="https://panta.market"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-fg-muted underline-offset-4 hover:text-fg hover:underline"
          >
            Powered by Panta
          </a>
        </p>
        <p className="max-w-md text-xs leading-relaxed">
          Copycall never holds your funds or keys. Every copy is reviewed and signed by your own wallet. Not financial
          advice.
        </p>
      </div>
    </footer>
  );
}
