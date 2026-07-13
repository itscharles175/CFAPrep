import { useMemo, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FlaskConical, Lightbulb } from 'lucide-react';
// K4-3 — migrated off bare recharts onto the shared, host-styled @visx viz
// barrel (src/domains/shared/components/viz). recharts is no longer a dependency.
import { LineTrend } from '../shared/components/viz';
import EmptyState from '../../components/EmptyState';
import FormulaBlock from '../../components/FormulaBlock';
import { quantModules } from '../../data/catalog';
import { quantContent } from '../../data/quantContent';
import { binomialOptionPrice, blackScholes, currency, durationShock, normalCdf, parametricVarCvar, percent } from '../../lib/financeMath';
import { downloadCsv } from '../../lib/exportUtils';
import { useModuleProgress } from '../../hooks/useProgress';
import { recordSkillLabAttempt, saveResultArtifact } from '../../lib/learning';
import { Panel, Surface } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';

function LabShell({ title, children, assumptions = {}, metrics = {}, csvRows }) {
  const [message, setMessage] = useState('');

  async function saveLabRep() {
    const topic = window.location.pathname.split('/').at(-1) || 'quant-lab';
    const sourceMeta = quantModules.find((module) => module.id === topic)?.sourceMeta || { level: 'level1', topicId: 'quant-methods' };
    const reviewTopic = sourceMeta.level === 'level1' ? sourceMeta.topicId : `${sourceMeta.level}:${sourceMeta.topicId}`;
    const artifact = await saveResultArtifact({
      type: 'quant-lab',
      domain: 'quant',
      level: sourceMeta.level,
      topic: reviewTopic,
      title,
      summary: `${title} completed as a CFA-mapped Quant skill lab.`,
      assumptions: { route: window.location.pathname, ...assumptions },
      metrics: { score: 100, ...metrics },
      path: window.location.pathname,
      objectiveIds: [`quant:${topic}:${sourceMeta.topicId}`],
    });
    await recordSkillLabAttempt({
      domain: 'quant',
      level: sourceMeta.level,
      topic: reviewTopic,
      labId: title,
      labType: 'quant-lab',
      objectiveIds: [`quant:${topic}:${sourceMeta.topicId}`],
      artifactId: artifact.id,
      score: 100,
      elapsedSeconds: 90,
    });
    setMessage('Lab rep saved');
  }

  function exportCsv() {
    downloadCsv(`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, csvRows || [
      ['field', 'value'],
      ...Object.entries(assumptions),
      ...Object.entries(metrics),
    ]);
    setMessage('CSV exported');
  }

  return (
    <Panel
      title={title}
      icon={FlaskConical}
      tone="quant"
      status="quant"
      className="lab-panel"
      actions={
        <>
          <button className="btn btn-secondary btn-sm" onClick={exportCsv}>Export CSV</button>
          <button className="btn btn-secondary btn-sm" onClick={saveLabRep}>Save Lab Rep</button>
        </>
      }
    >
      {children}
      {message && <p className="muted-copy">{message}</p>}
    </Panel>
  );
}

function NumberField({ label, value, onChange, step = '1', suffix }) {
  return (
    <label className="calc-field">
      <span>{label}</span>
      <div className="input-with-suffix">
        <input type="number" value={value} step={step} onChange={(event) => onChange(event.target.value)} />
        {suffix && <small>{suffix}</small>}
      </div>
    </label>
  );
}

function RiskTailLab() {
  const [portfolio, setPortfolio] = useState('1000000');
  const [vol, setVol] = useState('18');
  const [days, setDays] = useState('10');
  const [confidence, setConfidence] = useState('95');
  const risk = parametricVarCvar({
    portfolioValue: Number(portfolio),
    annualVolatility: Number(vol) / 100,
    days: Number(days),
    confidence: Number(confidence) / 100,
  });
  const varValue = risk?.varValue ?? NaN;
  const cvarValue = risk?.cvarValue ?? NaN;
  const breachProb = 1 - Number(confidence) / 100;

  return (
    <LabShell
      title="Tail-Risk Lens"
      assumptions={{ portfolio, vol, days, confidence }}
      metrics={{ varValue, cvarValue, breachProb }}
      csvRows={[
        ['metric', 'value'],
        ['VaR', varValue],
        ['CVaR', cvarValue],
        ['Breach probability', breachProb],
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Portfolio Value" value={portfolio} onChange={setPortfolio} suffix="$" />
        <NumberField label="Annual Volatility" value={vol} onChange={setVol} step="0.1" suffix="%" />
        <NumberField label="Horizon" value={days} onChange={setDays} suffix="days" />
        <label className="calc-field">
          <span>Confidence</span>
          <select value={confidence} onChange={(event) => setConfidence(event.target.value)}>
            <option value="95">95%</option>
            <option value="99">99%</option>
          </select>
        </label>
      </div>
      <div className="metric-row">
        <div><small>Parametric VaR</small><strong>{currency(varValue)}</strong></div>
        <div><small>Parametric CVaR</small><strong>{currency(cvarValue)}</strong></div>
        <div><small>Breach Probability</small><strong>{percent(breachProb, 1)}</strong></div>
      </div>
      <div className="data-table compact-table" aria-label="Tail risk table">
        <div><strong>Metric</strong><strong>Value</strong></div>
        <div><span>VaR</span><span>{currency(varValue)}</span></div>
        <div><span>CVaR</span><span>{currency(cvarValue)}</span></div>
        <div><span>Horizon volatility</span><span>{percent(risk?.horizonVol ?? NaN, 2)}</span></div>
      </div>
    </LabShell>
  );
}

function PortfolioRiskLab() {
  const [weight, setWeight] = useState('60');
  const [volA, setVolA] = useState('16');
  const [volB, setVolB] = useState('9');
  const [corr, setCorr] = useState('25');
  const w = Number(weight) / 100;
  const va = Number(volA) / 100;
  const vb = Number(volB) / 100;
  const rho = Number(corr) / 100;
  const portfolioVol = Math.sqrt(w * w * va * va + (1 - w) * (1 - w) * vb * vb + 2 * w * (1 - w) * rho * va * vb);

  return (
    <LabShell title="Covariance Risk Mixer">
      <div className="calc-grid">
        <NumberField label="Asset A Weight" value={weight} onChange={setWeight} suffix="%" />
        <NumberField label="Asset A Vol" value={volA} onChange={setVolA} suffix="%" />
        <NumberField label="Asset B Vol" value={volB} onChange={setVolB} suffix="%" />
        <NumberField label="Correlation" value={corr} onChange={setCorr} suffix="%" />
      </div>
      <div className="metric-row">
        <div><small>Portfolio Volatility</small><strong>{percent(portfolioVol, 2)}</strong></div>
        <div><small>Diversification Impact</small><strong>{percent(w * va + (1 - w) * vb - portfolioVol, 2)}</strong></div>
      </div>
    </LabShell>
  );
}

function deterministicNormal(index) {
  const u1 = Math.abs(Math.sin(index * 12.9898) * 43758.5453) % 1 || 0.5;
  const u2 = Math.abs(Math.sin(index * 78.233) * 24634.6345) % 1 || 0.5;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function BrownianPathLab() {
  const [drift, setDrift] = useState('6');
  const [vol, setVol] = useState('22');
  const path = useMemo(() => {
    return Array.from({ length: 31 }).reduce((points, _, index) => {
      if (index === 0) return [{ day: 0, price: 100 }];
      const dt = 1 / 252;
      const previous = points.at(-1).price;
      const next = previous * Math.exp((Number(drift) / 100 - (Number(vol) / 100) ** 2 / 2) * dt + (Number(vol) / 100) * Math.sqrt(dt) * deterministicNormal(index));
      return [...points, { day: index, price: Number(next.toFixed(2)) }];
    }, []);
  }, [drift, vol]);
  // Preserve the recharts `domain={['dataMin - 2', 'dataMax + 2']}` padding.
  const priceDomain = useMemo(() => {
    const prices = path.map((point) => point.price);
    return [Math.min(...prices) - 2, Math.max(...prices) + 2];
  }, [path]);

  return (
    <LabShell title="Geometric Brownian Path">
      <div className="calc-grid">
        <NumberField label="Annual Drift" value={drift} onChange={setDrift} step="0.1" suffix="%" />
        <NumberField label="Annual Volatility" value={vol} onChange={setVol} step="0.1" suffix="%" />
      </div>
      <div className="chart-frame">
        <LineTrend
          data={path}
          xKey="day"
          height={240}
          yDomain={priceDomain}
          series={[
            { dataKey: 'price', name: 'Price', color: 'var(--accent, #60a5fa)', area: true },
          ]}
        />
      </div>
    </LabShell>
  );
}

function OptionSurfaceLab() {
  const [spot, setSpot] = useState('100');
  const [strike, setStrike] = useState('100');
  const [vol, setVol] = useState('20');
  const model = blackScholes({ spot: Number(spot), strike: Number(strike), years: 1, annualRate: 0.05, volatility: Number(vol) / 100 });
  const payoff = useMemo(() => (
    Array.from({ length: 21 }, (_, index) => {
      const price = 50 + index * 5;
      return { price, call: Math.max(0, price - Number(strike)), put: Math.max(0, Number(strike) - price) };
    })
  ), [strike]);

  return (
    <LabShell
      title="Option Value And Payoff"
      assumptions={{ spot, strike, vol }}
      metrics={{ call: model?.call ?? NaN, put: model?.put ?? NaN, deltaCall: model?.deltaCall ?? NaN }}
      csvRows={[
        ['underlying_price', 'call_payoff', 'put_payoff'],
        ...payoff.map((row) => [row.price, row.call, row.put]),
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Spot Price" value={spot} onChange={setSpot} suffix="$" />
        <NumberField label="Strike Price" value={strike} onChange={setStrike} suffix="$" />
        <NumberField label="Volatility" value={vol} onChange={setVol} suffix="%" />
      </div>
      <div className="metric-row">
        <div><small>Call Value</small><strong>{currency(model?.call ?? NaN)}</strong></div>
        <div><small>Put Value</small><strong>{currency(model?.put ?? NaN)}</strong></div>
        <div><small>Delta</small><strong>{model ? model.deltaCall.toFixed(3) : '-'}</strong></div>
      </div>
      <div className="chart-frame">
        <LineTrend
          data={payoff}
          xKey="price"
          height={220}
          series={[
            { dataKey: 'call', name: 'Call', color: 'var(--success, #34d399)', strokeWidth: 2 },
            { dataKey: 'put', name: 'Put', color: 'var(--danger, #f87171)', strokeWidth: 2 },
          ]}
        />
      </div>
    </LabShell>
  );
}

function BinomialTreeLab() {
  const [spot, setSpot] = useState('100');
  const [strike, setStrike] = useState('100');
  const [vol, setVol] = useState('22');
  const [steps, setSteps] = useState('4');
  const tree = useMemo(() => binomialOptionPrice({
    spot: Number(spot),
    strike: Number(strike),
    annualRate: 0.05,
    volatility: Number(vol) / 100,
    years: 1,
    steps: Number(steps),
  }), [spot, steps, strike, vol]);

  return (
    <LabShell
      title="Binomial Option Tree"
      assumptions={{ spot, strike, vol, steps }}
      metrics={{ price: tree?.price ?? NaN, riskNeutralProbability: tree?.probability ?? NaN }}
      csvRows={[
        ['step', 'node_values'],
        ...(tree?.tree || []).map((row) => [row.step, row.values.join(' | ')]),
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Spot Price" value={spot} onChange={setSpot} suffix="$" />
        <NumberField label="Strike Price" value={strike} onChange={setStrike} suffix="$" />
        <NumberField label="Volatility" value={vol} onChange={setVol} suffix="%" />
        <NumberField label="Steps" value={steps} onChange={setSteps} />
      </div>
      <div className="metric-row">
        <div><small>Tree Price</small><strong>{currency(tree?.price ?? NaN)}</strong></div>
        <div><small>Risk-Neutral p</small><strong>{percent(tree?.probability ?? NaN, 2)}</strong></div>
        <div><small>Up / Down</small><strong>{tree ? `${tree.up.toFixed(3)} / ${tree.down.toFixed(3)}` : '-'}</strong></div>
      </div>
      <div className="data-table compact-table" aria-label="Binomial tree node values">
        <div><strong>Step</strong><strong>Node values</strong></div>
        {(tree?.tree || []).map((row) => (
          <div key={row.step}><span>{row.step}</span><span>{row.values.join(' | ')}</span></div>
        ))}
      </div>
    </LabShell>
  );
}

function StressVarLab() {
  const [portfolio, setPortfolio] = useState('2500000');
  const [vol, setVol] = useState('20');
  const [shock, setShock] = useState('-12');
  const normalVar = Number(portfolio) * 1.645 * (Number(vol) / 100 / Math.sqrt(252)) * Math.sqrt(10);
  const stressLoss = Number(portfolio) * Math.abs(Number(shock) / 100);

  return (
    <LabShell title="VaR Versus Stress Loss">
      <div className="calc-grid">
        <NumberField label="Portfolio Value" value={portfolio} onChange={setPortfolio} suffix="$" />
        <NumberField label="Annual Volatility" value={vol} onChange={setVol} suffix="%" />
        <NumberField label="Stress Shock" value={shock} onChange={setShock} suffix="%" />
      </div>
      <div className="metric-row">
        <div><small>10-Day 95% VaR</small><strong>{currency(normalVar)}</strong></div>
        <div><small>Stress Loss</small><strong>{currency(stressLoss)}</strong></div>
      </div>
    </LabShell>
  );
}

function DurationShockLab() {
  const [price, setPrice] = useState('100');
  const [duration, setDuration] = useState('6.2');
  const [convexity, setConvexity] = useState('45');
  const [shock, setShock] = useState('100');
  const result = durationShock({
    price: Number(price),
    modifiedDuration: Number(duration),
    convexity: Number(convexity),
    shockBps: Number(shock),
  });
  const scenarios = [-100, -50, 0, 50, 100, 150].map((bps) => ({
    bps,
    ...durationShock({ price: Number(price), modifiedDuration: Number(duration), convexity: Number(convexity), shockBps: bps }),
  }));

  return (
    <LabShell
      title="Duration Shock Table"
      assumptions={{ price, duration, convexity, shock }}
      metrics={{ shockedPrice: result?.shockedPrice ?? NaN, priceChange: result?.priceChange ?? NaN }}
      csvRows={[
        ['shock_bps', 'pct_change', 'price_change', 'shocked_price'],
        ...scenarios.map((row) => [row.bps, row.pctChange, row.priceChange, row.shockedPrice]),
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Bond Price" value={price} onChange={setPrice} />
        <NumberField label="Modified Duration" value={duration} onChange={setDuration} step="0.1" />
        <NumberField label="Convexity" value={convexity} onChange={setConvexity} step="1" />
        <NumberField label="Shock" value={shock} onChange={setShock} suffix="bps" />
      </div>
      <div className="metric-row">
        <div><small>Shocked Price</small><strong>{currency(result?.shockedPrice ?? NaN)}</strong></div>
        <div><small>Price Change</small><strong>{currency(result?.priceChange ?? NaN)}</strong></div>
        <div><small>Percent Change</small><strong>{percent(result?.pctChange ?? NaN, 2)}</strong></div>
      </div>
      <div className="data-table compact-table" aria-label="Duration shock scenarios">
        <div><strong>Shock</strong><strong>Price</strong><strong>Change</strong></div>
        {scenarios.map((row) => (
          <div key={row.bps}><span>{row.bps} bps</span><span>{currency(row.shockedPrice)}</span><span>{percent(row.pctChange, 2)}</span></div>
        ))}
      </div>
    </LabShell>
  );
}

function EfficientFrontierLab() {
  const [weight, setWeight] = useState('55');
  const w = Number(weight) / 100;
  const ret = w * 0.11 + (1 - w) * 0.055;
  const risk = Math.sqrt(w * w * 0.18 * 0.18 + (1 - w) * (1 - w) * 0.07 * 0.07 + 2 * w * (1 - w) * 0.25 * 0.18 * 0.07);
  const frontier = Array.from({ length: 21 }, (_, index) => {
    const wf = index / 20;
    const r = wf * 0.11 + (1 - wf) * 0.055;
    const sigma = Math.sqrt(wf * wf * 0.18 * 0.18 + (1 - wf) * (1 - wf) * 0.07 * 0.07 + 2 * wf * (1 - wf) * 0.25 * 0.18 * 0.07);
    return { weight: Math.round(wf * 100), return: Number((r * 100).toFixed(2)), risk: Number((sigma * 100).toFixed(2)) };
  });

  return (
    <LabShell
      title="Two-Asset Frontier"
      assumptions={{ weight }}
      metrics={{ expectedReturn: ret, portfolioRisk: risk, lossProbability: normalCdf(-ret / risk) }}
      csvRows={[
        ['growth_asset_weight', 'return_pct', 'risk_pct'],
        ...frontier.map((row) => [row.weight, row.return, row.risk]),
      ]}
    >
      <NumberField label="Growth Asset Weight" value={weight} onChange={setWeight} suffix="%" />
      <div className="metric-row">
        <div><small>Expected Return</small><strong>{percent(ret, 2)}</strong></div>
        <div><small>Portfolio Risk</small><strong>{percent(risk, 2)}</strong></div>
        <div><small>Normal Loss Probability</small><strong>{percent(normalCdf(-ret / risk), 2)}</strong></div>
      </div>
      <div className="chart-frame">
        <LineTrend
          data={frontier}
          xKey="risk"
          height={220}
          series={[
            { dataKey: 'return', name: 'Return %', color: 'var(--accent, #60a5fa)', strokeWidth: 2, dots: true },
          ]}
        />
      </div>
      <div className="data-table compact-table" aria-label="Efficient frontier scenario table">
        <div><strong>Weight</strong><strong>Return</strong><strong>Risk</strong></div>
        {frontier.filter((_, index) => index % 4 === 0).map((row) => (
          <div key={row.weight}><span>{row.weight}%</span><span>{row.return}%</span><span>{row.risk}%</span></div>
        ))}
      </div>
    </LabShell>
  );
}

function ModuleLab({ lab }) {
  if (lab === 'risk-tail') return <RiskTailLab />;
  if (lab === 'portfolio-risk') return <PortfolioRiskLab />;
  if (lab === 'brownian-path') return <BrownianPathLab />;
  if (lab === 'option-surface') return <><OptionSurfaceLab /><BinomialTreeLab /></>;
  if (lab === 'stress-var') return <><StressVarLab /><DurationShockLab /></>;
  if (lab === 'efficient-frontier') return <EfficientFrontierLab />;
  return null;
}

export default function QuantModule() {
  const { module: modId } = useParams();
  const location = useLocation();
  const data = quantContent[modId];
  const sourceMeta = quantModules.find((module) => module.id === modId)?.sourceMeta || { level: 'level1', topicId: 'quant-methods' };
  const { completed, toggleComplete } = useModuleProgress({
    domain: 'quant',
    moduleId: data ? modId : null,
    title: data?.title || modId,
    path: location.pathname,
  });

  if (!data) {
    return (
      <div className="page-container">
        <EmptyState
          title="Quant module not found"
          description="That quantitative finance module is not in the current catalog."
          actionLabel="Back to Quant Finance"
          actionTo="/quant"
        />
      </div>
    );
  }

  return (
    <div className="page-container">
      <Link to="/quant" className="back-link">
        <ArrowLeft size={16} /> Back to Quant Finance
      </Link>

      <div className="module-header">
        <div>
          <div className="badge badge-purple">{data.level} Quant Lab</div>
          <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>{data.title}</h1>
          <p className="section-subtitle" style={{ marginBottom: 0 }}>{data.summary}</p>
        </div>
        <button className={`btn ${completed ? 'btn-success' : 'btn-secondary'} btn-lg`} onClick={toggleComplete}>
          <CheckCircle2 size={18} /> {completed ? 'Completed' : 'Mark Complete'}
        </button>
      </div>

      <div className="learning-layout">
        <div className="module-content">
          {data.sections.map((section, index) => (
            <Surface key={section.title} tone="quant" className="module-section-panel animate-fade" style={{ animationDelay: `${index * 80}ms` }}>
              <h2 style={{ marginTop: 0 }}>{section.title}</h2>
              <p>{section.content}</p>
              <div className="key-concept">
                <h4><Lightbulb size={16} /> Desk Notes</h4>
                <ul className="qv-m-0" style={{ paddingLeft: 'var(--space-5)' }}>
                  {section.keyPoints.map((point) => <li key={point}>{point}</li>)}
                </ul>
              </div>
            </Surface>
          ))}
        </div>

        <aside className="learning-sidebar">
          <Panel tone="quant" title="Outcomes">
            <ul className="outcome-list">
              {data.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}
            </ul>
          </Panel>

          <Panel tone="quant" title="Formula Reference">
            {data.formulas.map((formula) => <FormulaBlock key={formula.name} {...formula} />)}
          </Panel>
          <SourceRail
            compact
            limit={2}
            title="CFA Source Context"
            target={{
              kind: 'tool',
              domain: 'quant',
              level: sourceMeta.level,
              topicId: sourceMeta.topicId,
              pathway: sourceMeta.pathway,
              title: data.title,
              formulaNames: data.formulas.map((formula) => formula.name),
              keywords: [data.summary, ...data.outcomes, ...data.sections.map((section) => section.title)],
              route: location.pathname,
            }}
          />
        </aside>
      </div>

      <ModuleLab lab={data.lab} />
    </div>
  );
}
