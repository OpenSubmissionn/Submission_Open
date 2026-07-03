export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between">
        <div className="h-4 w-16 rounded bg-white/5" />
        <div className="h-3 w-40 rounded bg-white/5" />
      </div>

      <div className="animate-pulse flex-col gap-4" aria-hidden="true">
        <div className="glass h-20 w-full" />
        <div className="mt-4 h-11 w-full rounded-xl border border-white/10 bg-white/[0.03]" />
        <div className="glass mt-4 h-64 w-full" />
      </div>

      <span className="sr-only" role="status">
        Carregando o analisador…
      </span>
    </main>
  );
}
