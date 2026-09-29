/** Always-visible banner in mock mode (addendum I). Rendered only when MOCK_PANTA=true. */
export function MockBanner() {
  return (
    <div role="status" className="border-b border-amber-300/25 bg-[#1c1708] text-amber-300">
      <p className="label mx-auto flex max-w-[76rem] flex-wrap items-center gap-x-2 px-4 py-2 sm:px-6">
        <span className="font-semibold">Mock mode</span>
        <span aria-hidden className="text-amber-300/60">
          /
        </span>
        <span className="normal-case tracking-normal text-amber-300/90">
          Sample data and simulated signing. Nothing here is live Panta data or a real transaction.
        </span>
      </p>
    </div>
  );
}
