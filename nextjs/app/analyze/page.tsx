'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { AccountModel } from '@/components/AccountModel';
import { AccountDiff } from '@/components/tabs/AccountDiff';
import { CpiTree } from '@/components/tabs/CpiTree';
import { Explanation } from '@/components/tabs/Explanation';
import { FlameGraph } from '@/components/tabs/FlameGraph';
import { Learn } from '@/components/tabs/Learn';
import { CuBars } from '@/components/ui/CuBars';
import { InsightCard } from '@/components/ui/InsightCard';
import { TabBar, type TabItem } from '@/components/ui/TabBar';
import { TransactionInput } from '@/components/ui/TransactionInput';
import { analyzeTransaction, ApiRequestError, getLatestTx } from '@/lib/api';
import type { AnalysisResult, Network } from '@/lib/types';
import { cn, formatCU, formatPercent, formatSol } from '@/lib/utils';

const GITHUB_URL = 'https://github.com/OpenSubmissionn/Open_DevTool';

const TABS: TabItem[] = [
  { id: 'flame', label: 'Flame Graph' },
  { id: 'cpi', label: 'CPI Tree' },
  { id: 'diff', label: 'Account Diff' },
  { id: 'model', label: 'Account Model' },
  { id: 'explanation', label: 'Explanation' },
  { id: 'learn', label: 'Learn' },
];

export default function AnalyzePage(): React.JSX.Element {
  const [signature, setSignature] = useState('');
  const [network, setNetwork] = useState<Network>('mainnet');
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('flame');

  const runAnalysis = useCallback(async (sig: string, net: Network): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeTransaction(sig, net);
      setData(result);
      setActiveTab('flame');
    } catch (err) {
      setData(null);
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Erro inesperado ao analisar a transação.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleUseSample = useCallback(async (): Promise<void> => {
    setSampleLoading(true);
    setError(null);
    try {
      const latest = await getLatestTx();
      setSignature(latest.signature);
      setNetwork(latest.network);
      await runAnalysis(latest.signature, latest.network);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Não foi possível buscar uma amostra ao vivo.',
      );
    } finally {
      setSampleLoading(false);
    }
  }, [runAnalysis]);

  const insights = (data?.insights ?? []).slice(0, 6);

  return (
    <>
      <CuBars />

      <nav className="site-nav">
        <div className="nav-inner">
          <Link href="/" className="logo" aria-label="OPEN home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/open-wordmark.svg" alt="OPEN" height={26} style={{ height: 26, width: 'auto' }} />
          </Link>
          <div className="nav-links">
            <Link href="/" className="back-link">← Landing</Link>
            <a href="/#features" className="nav-link">Features</a>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="nav-cta">
              GitHub →
            </a>
          </div>
        </div>
      </nav>

      <main id="main" className="relative z-[1]">
        <header className="demo-hero mx-auto w-full max-w-[1320px] px-7">
          <div className="preview-banner">
            <span className="dot" aria-hidden="true" />
            <span>live · mainnet</span>
          </div>
          <div className="eyebrow">// Web Version</div>
          <h1>
            Try Open <span className="accent">right now</span>
          </h1>
          <p>
            Paste a Solana transaction signature or use the live sample. Navigate the tabs to explore
            the flame graph, CPI tree, account diff and more.
          </p>
        </header>

        <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-7 pb-24">
          <div className="mx-auto w-full max-w-[760px]">
            <TransactionInput
              signature={signature}
              network={network}
              loading={loading}
              sampleLoading={sampleLoading}
              onSignatureChange={setSignature}
              onNetworkChange={setNetwork}
              onSubmit={() => void runAnalysis(signature, network)}
              onUseSample={() => void handleUseSample()}
            />

            {error ? (
              <div role="alert" className="mt-4 rounded-xl border border-red/40 bg-red/5 p-4 text-sm text-red">
                {error}
              </div>
            ) : null}
          </div>

          {loading ? <ResultsSkeleton /> : null}

          {!loading && !data && !error ? <EmptyState /> : null}

          {!loading && data ? (
            <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-6">
              <SummaryBar data={data} />

              {insights.length > 0 ? (
                <section aria-label="Insights" className="grid gap-3 sm:grid-cols-2">
                  {insights.map((insight, index) => (
                    <InsightCard
                      key={`${insight.type}-${index}`}
                      severity={insight.severity}
                      title={insight.title}
                      message={insight.message}
                      recommendation={insight.recommendation}
                      estimatedCUSavings={insight.estimatedCUSavings}
                    />
                  ))}
                </section>
              ) : null}

              <div className="demo-card">
                <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

                <section
                  role="tabpanel"
                  id={`panel-${activeTab}`}
                  aria-labelledby={`tab-${activeTab}`}
                  tabIndex={0}
                  className="demo-panels animate-panel-fade"
                >
                  {activeTab === 'flame' ? (
                    <FlameGraph
                      programs={data.programs}
                      computeUnits={data.computeUnits}
                      bottleneck={data.bottleneck}
                    />
                  ) : null}
                  {activeTab === 'cpi' ? (
                    <CpiTree
                      cpiTree={data.cpiTree}
                      bottleneck={data.bottleneck}
                      instructionNames={data.instructionNames}
                    />
                  ) : null}
                  {activeTab === 'diff' ? <AccountDiff accountDiffs={data.accountDiffs} /> : null}
                  {activeTab === 'model' ? <AccountModel accountModel={data.accountModel} /> : null}
                  {activeTab === 'explanation' ? (
                    <Explanation
                      instructions={data.instructions}
                      executionTrace={data.executionTrace}
                      flow={data.flow}
                    />
                  ) : null}
                  {activeTab === 'learn' ? <Learn learn={data.learn} /> : null}
                </section>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}

function SummaryBar({ data }: { data: AnalysisResult }): React.JSX.Element {
  return (
    <section aria-label="Resumo da transação" className="glass flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
      <StatusChip success={data.success} />
      <Stat label="Rede" value={data.network === 'mainnet' ? 'Mainnet' : 'Devnet'} />
      <Stat label="Slot" value={data.slot.toLocaleString('en-US')} mono />
      <Stat label="Taxa" value={formatSol(data.feeSol)} mono />
      <Stat
        label="Compute units"
        value={`${formatCU(data.computeUnits.consumed)} / ${formatCU(data.computeUnits.limit)}`}
        mono
      />
      {data.txType ? <Stat label="Tipo" value={data.txType} /> : null}
      {data.bottleneck ? (
        <div className="ml-auto flex items-center gap-2 rounded-lg border border-orange/30 bg-orange/5 px-3 py-1.5 text-xs">
          <span className="font-semibold uppercase tracking-wide text-orange">Gargalo</span>
          <span className="text-fg">{data.bottleneck.programName}</span>
          <span className="tnum text-fg-mute">
            {formatCU(data.bottleneck.cuConsumed)} CU · {formatPercent(data.bottleneck.sharePercent)}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function StatusChip({ success }: { success: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        success ? 'bg-green/15 text-green' : 'bg-red/15 text-red',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', success ? 'bg-green' : 'bg-red')} />
      {success ? 'Sucesso' : 'Falhou'}
    </span>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-fg-mute">{label}</span>
      <span className={cn('text-sm text-fg', mono && 'mono tnum')}>{value}</span>
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="glass flex flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="text-sm font-medium text-fg">Cole uma assinatura para começar</p>
      <p className="max-w-sm text-xs text-fg-mute">
        Analise qualquer transação Solana ou use uma amostra ao vivo para ver o flame graph, a
        árvore de CPIs, o diff de contas e mais.
      </p>
    </div>
  );
}

function ResultsSkeleton(): React.JSX.Element {
  return (
    <div className="flex animate-pulse flex-col gap-4" aria-hidden="true">
      <div className="glass h-16 w-full" />
      <div className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.03]" />
      <div className="glass h-64 w-full" />
    </div>
  );
}
