import { ChessCoachBoard } from "@/components/ChessCoachBoard";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center bg-stone-50 px-6 py-10 text-stone-950 sm:px-10 lg:px-16">
      <section className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,520px)]">
        <div className="max-w-2xl">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Position analysis workspace
          </p>
          <h1 className="text-5xl font-semibold tracking-tight text-stone-950 sm:text-6xl">
            My Chess Coach
          </h1>
          <p className="mt-5 max-w-xl text-xl leading-8 text-stone-700">
            Personal chess position analysis tool
          </p>

          <div
            className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-base font-medium leading-7 text-amber-950"
            role="note"
          >
            For study and post-game analysis only. Do not use during live
            games.
          </div>
        </div>

        <ChessCoachBoard />
      </section>
    </main>
  );
}
