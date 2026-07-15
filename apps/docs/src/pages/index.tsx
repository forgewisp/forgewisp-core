import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';

import styles from './index.module.css';

type Feature = {
  icon: string;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: '🛡️',
    title: 'Risk tiers as a boundary',
    body: 'read / write / destructive. write & destructive tools require a confirmation callback, and confirm UI is rendered from schema-validated args — never model text.',
  },
  {
    icon: '📐',
    title: 'JSON Schema validation',
    body: 'Every tool call is validated with Ajv before it ever runs. Strict schemas (additionalProperties: false, bounded, enums) keep the model honest.',
  },
  {
    icon: '🌊',
    title: 'OpenAI-compatible streaming',
    body: 'A direct SSE parser: text deltas, tool-call fragment accumulation, and a dual reasoning stream — with per-chunk callbacks for real-time UX.',
  },
  {
    icon: '📝',
    title: 'Bounded audit log',
    body: 'Every request, validation, confirmation, and tool result is recorded in a bounded ring with optional redaction. Audit callbacks never break the loop.',
  },
  {
    icon: '🌐',
    title: 'Runs in the browser',
    body: 'No mandatory backend. Point at any OpenAI-compatible endpoint with an optional API key. Your app’s own functions are the tools.',
  },
  {
    icon: '🧩',
    title: 'Composable packages',
    body: 'core is the engine. bundled-tools ships a catalog. mcp adapts an MCP server’s tools. Take what you need; keep your bundle lean.',
  },
];

type Pkg = { name: string; desc: string; to: string };

const PACKAGES: Pkg[] = [
  {
    name: '@forgewisp/core',
    desc: 'The library. createAgent(config) + a tiny typed surface.',
    to: '/docs/core',
  },
  {
    name: '@forgewisp/bundled-tools',
    desc: 'A catalog of ready-to-register browser-effects tools.',
    to: '/docs/bundled-tools',
  },
  {
    name: '@forgewisp/mcp',
    desc: 'Adapt an MCP server’s tools into agent tools (OAuth + PKCE).',
    to: '/docs/mcp',
  },
];

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.eyebrow}>Function-calling AI agents, in the browser</div>
          <Heading as="h1" className={styles.heroTitle}>
            Your app’s functions, <span className={styles.accent}>as the agent’s tools</span>.
          </Heading>
          <p className={styles.heroSubtitle}>
            {siteConfig.tagline}. Schema-validated, risk-tiered, streamed, and audited — with no
            mandatory backend.
          </p>
          <div className={styles.cta}>
            <Link className="button button--primary button--lg" to="/docs/intro">
              Get started
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/core">
              Read the docs
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className={styles.features}>
          <h2 className={styles.sectionHeading}>Why Forgewisp</h2>
          <div className={styles.featuresGrid}>
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.feature}>
                <div className={styles.featureIcon}>{f.icon}</div>
                <h3 className={styles.featureTitle}>{f.title}</h3>
                <p className={styles.featureBody}>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.packages}>
          <h2 className={styles.sectionHeading}>Three packages</h2>
          <div className={styles.packagesRow}>
            {PACKAGES.map((p) => (
              <Link key={p.name} to={p.to} className={styles.packageLink}>
                <div className={styles.package}>
                  <div className={styles.packageName}>{p.name}</div>
                  <p className={styles.packageDesc}>{p.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
