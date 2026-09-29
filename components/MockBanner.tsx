/** Always-visible banner in mock mode (addendum I). Rendered only when MOCK_PANTA=true. */
export function MockBanner() {
  return (
    <div
      role="status"
      className="relative z-50 border-b border-amber-300/30 bg-[rgb(40_32_10/0.85)] px-4 py-2 text-center text-xs font-semibold tracking-wide text-amber-300 backdrop-blur-md sm:text-sm"
    >
      MOCK MODE · sample data, simulated signing. Nothing here is live Panta data or a real transaction.
    </div>
  );
}
