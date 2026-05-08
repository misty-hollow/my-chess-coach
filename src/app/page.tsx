import { ChessCoachBoard } from "@/components/ChessCoachBoard";

export default function Home() {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-950">
      <header className="border-b border-stone-200 bg-white/90 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-base font-semibold text-stone-950">
            My Chess Coach
          </h1>
          <p
            className="max-w-full rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium leading-5 text-amber-900"
            role="note"
          >
            For study and post-game analysis only. Do not use during live games.
          </p>
        </div>
      </header>

      <section className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-5">
        <ChessCoachBoard />
      </section>
    </main>
  );
}
