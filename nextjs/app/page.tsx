import Link from 'next/link';
import { HeroDots } from '@/components/landing/HeroDots';
import { InstallLine } from '@/components/landing/InstallLine';
import { SectionHead } from '@/components/landing/SectionHead';
import { CuBars } from '@/components/ui/CuBars';

const GITHUB_URL = 'https://github.com/OpenSubmissionn/Open_DevTool';
const CONTAINER = 'relative z-[1] mx-auto w-full max-w-[1200px] px-7';

interface Feature {
  icon: string;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  { icon: 'CU', title: 'CU Profiler', description: 'Per-instruction compute unit breakdown with hotspot detection.' },
  { icon: '⌥', title: 'CPI Call Tree', description: 'Reconstructed from program logs — see who calls whom, and how deep.' },
  { icon: 'Δ', title: 'Account Diffs', description: 'Pre/post state for every touched account, decoded when possible.' },
  { icon: '!', title: 'Insight Engine', description: 'Flags missing PDA bump caches, redundant CPIs, oversized account loads.' },
  { icon: '⚠', title: 'Anomaly Detection', description: 'Outlier CU spikes vs. historical baseline for the same program.' },
  { icon: '$', title: 'Cost Analysis', description: 'Lamport breakdown — base fee, priority fee, rent, transfer totals.' },
  { icon: '⇄', title: 'Framework Compare', description: 'See how the same logic would cost in Anchor, Pinocchio, or raw SVM.' },
  { icon: '▤', title: 'Batch Mode', description: 'Run analysis across a file of signatures and aggregate the report.' },
];

function GitHubIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2c-3.34.73-4.04-1.6-4.04-1.6-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 0Z" />
    </svg>
  );
}

export default function LandingPage(): React.JSX.Element {
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
            <a href="#versions" className="nav-link">Versions</a>
            <a href="#modes" className="nav-link">How it works</a>
            <a href="#features" className="nav-link">Features</a>
            <Link href="/analyze" className="nav-web" aria-label="Open the web version">
              <span className="live-dot" aria-hidden="true" />
              Web Version
              <span className="arrow" aria-hidden="true">→</span>
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="nav-cta">
              GitHub →
            </a>
          </div>
        </div>
      </nav>

      <main id="main">
        {/* HERO */}
        <header className={`hero ${CONTAINER}`}>
          <HeroDots />
          <h1 className="tagline">
            <span className="word accent" style={{ '--i': 0 } as React.CSSProperties}>Chrome</span>{' '}
            <span className="word accent" style={{ '--i': 1 } as React.CSSProperties}>DevTools</span>
            <br />
            <span className="word" style={{ '--i': 2 } as React.CSSProperties}>for</span>{' '}
            <span className="word" style={{ '--i': 3 } as React.CSSProperties}>Solana</span>
          </h1>
          <p className="subtitle">
            Paste your transaction signature and get all the information you need.
          </p>

          <div className="cta-row">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
              <GitHubIcon />
              Star on GitHub
            </a>
            <a href="#versions" className="btn btn-ghost">
              See versions →
            </a>
          </div>

          <p className="install-hint">Install the CLI using the command below:</p>
          <InstallLine />
        </header>

        {/* VERSIONS */}
        <section id="versions" className={`block ${CONTAINER}`}>
          <SectionHead
            eyebrow="// versions"
            title="Two ways to run open"
            subtitle="Both versions are live today. Pick the CLI for terminal speed, or the web debugger for an interactive view."
          />

          <div className="versions-grid">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="version-card available">
              <span className="version-badge live">
                <span className="pulse" />
                Available now
              </span>
              <h3>CLI</h3>
              <p className="desc">
                Profile transactions straight from your terminal. Pipe to JSON, export CSV, or read
                the rendered TUI in real time.
              </p>
              <ul>
                <li><span className="check">●</span> Global install via npm</li>
                <li><span className="check">●</span> Mainnet, devnet &amp; custom RPC</li>
                <li><span className="check">●</span> JSON, CSV &amp; terminal renderers</li>
                <li><span className="check">●</span> Batch mode for many signatures</li>
              </ul>
              <span className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', pointerEvents: 'none' }}>
                View on GitHub →
              </span>
            </a>

            <Link href="/analyze" className="version-card available">
              <span className="version-badge live">
                <span className="pulse" />
                Available now
              </span>
              <h3>Web</h3>
              <p className="desc">
                A browser-based visual debugger — paste a signature, get an interactive flame graph,
                CPI tree and account state timeline.
              </p>
              <ul>
                <li><span className="check">●</span> Interactive CU flame graph</li>
                <li><span className="check">●</span> Clickable CPI call tree</li>
                <li><span className="check">●</span> Side-by-side simulation diff</li>
                <li><span className="check">●</span> Shareable transaction reports</li>
              </ul>
              <span className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', pointerEvents: 'none' }}>
                Open the web app →
              </span>
            </Link>
          </div>
        </section>

        {/* MODES */}
        <section id="modes" className={`block ${CONTAINER}`}>
          <SectionHead
            eyebrow="// run modes"
            title="Run on a real signature, or simulate from a file"
            subtitle="Already broadcast? Decode it. Still drafting? Profile it before you sign."
          />

          <div className="modes-grid">
            <div className="mode-card">
              <div className="mode-card-head">
                <div className="mode-icon live">⚡</div>
                <h3>On-chain signature</h3>
                <p>
                  Point OPEN at any confirmed transaction signature. It pulls the tx from the RPC and
                  gives you the full profile — CU usage, CPI tree, account diffs.
                </p>
              </div>
              <div className="mode-terminal">
                <div className="line">
                  <span className="prompt">$</span>
                  <span className="cmd">opendev tx <span className="arg">&lt;SIGNATURE&gt;</span></span>
                </div>
                <div className="out">→ fetched from mainnet · <span className="ok">✓ decoded</span></div>
                <div className="out">→ 8 instructions · 4 CPIs · <span className="warn">312k CU</span></div>
                <div className="line" style={{ marginTop: 10 }}>
                  <span className="prompt">$</span>
                  <span className="cmd">opendev tx <span className="arg">&lt;SIGNATURE&gt;</span> --network devnet --json</span>
                </div>
              </div>
            </div>

            <div className="mode-card">
              <div className="mode-card-head">
                <div className="mode-icon simulate">∿</div>
                <h3>Simulate from file</h3>
                <p>
                  Have a base64 transaction blob you haven&apos;t broadcast yet? Pass the path (or the
                  blob itself) and opendev will simulate it against current state.
                </p>
              </div>
              <div className="mode-terminal">
                <div className="line">
                  <span className="prompt">$</span>
                  <span className="cmd">opendev simulate <span className="arg">./my-tx.b64</span></span>
                </div>
                <div className="out">→ simulating against mainnet state...</div>
                <div className="out">→ <span className="ok">✓ would succeed</span> · 184k CU</div>
                <div className="line" style={{ marginTop: 10 }}>
                  <span className="prompt">$</span>
                  <span className="cmd">opendev simulate <span className="arg">&lt;BASE64_BLOB&gt;</span></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" className={`block ${CONTAINER}`}>
          <SectionHead
            eyebrow="// features"
            title="Everything you need to debug a Solana transaction"
            subtitle="Built around the same questions you'd ask in Chrome DevTools — but for the SVM."
          />

          <div className="features-grid">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="feature">
                <div className="feature-icon">{feature.icon}</div>
                <h4>{feature.title}</h4>
                <p>{feature.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="final-cta">
          <div className={CONTAINER}>
            <h2>Ship faster. Profile everything.</h2>
            <p>OPEN is MIT-licensed and open source. Try it on a real signature in 30 seconds.</p>
            <div className="cta-row" style={{ justifyContent: 'center' }}>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
                <GitHubIcon />
                Open the repo
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className={CONTAINER}>
          <div className="footer-grid">
            <div className="footer-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="footer-mark" src="/open-wordmark.svg" alt="OPEN" width={110} />
              <p className="footer-tagline">
                Solana transaction analyzer for developers. See what your transaction actually did.
              </p>
              <span className="footer-status" title="backend status">
                <span className="dot" />
                <span>online · mainnet</span>
              </span>
            </div>

            <div>
              <h4 className="footer-col-title">Product</h4>
              <ul className="footer-col-links">
                <li><a href="#features">Features</a></li>
                <li><a href="#modes">Modes</a></li>
                <li><a href="#versions">Versions</a></li>
                <li><Link href="/analyze">Try web demo</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="footer-col-title">Resources</h4>
              <ul className="footer-col-links">
                <li><a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://open-dbe26606.mintlify.app/" target="_blank" rel="noopener noreferrer">Documentation</a></li>
                <li><a href={`${GITHUB_URL}/tree/main/cli`} target="_blank" rel="noopener noreferrer">CLI</a></li>
                <li><a href={`${GITHUB_URL}/blob/main/CHANGELOG.md`} target="_blank" rel="noopener noreferrer">Changelog</a></li>
              </ul>
            </div>

            <div>
              <h4 className="footer-col-title">Community</h4>
              <ul className="footer-col-links">
                <li><a href="https://x.com/OpenDevT" target="_blank" rel="noopener noreferrer" aria-label="OPEN on X (Twitter)">@OpenDevT</a></li>
                <li><a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">Issues</a></li>
              </ul>
            </div>

            <div>
              <h4 className="footer-col-title">Legal</h4>
              <ul className="footer-col-links">
                <li><a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT License</a></li>
              </ul>
            </div>
          </div>

          <div className="footer-bottom">
            <code className="footer-prompt" aria-hidden="true">
              <span className="p-path">~/open</span>
              <span className="p-sigil">$</span>
              <span className="p-cmd">npm install -g opendevtool</span>
              <span className="footer-cursor" />
            </code>
            <span className="footer-meta-right">
              <span className="footer-version">v0.4.0 · mainnet-beta</span>
              <span className="accent">© 2026 OPEN · MIT</span>
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
