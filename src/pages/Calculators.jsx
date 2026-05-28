import { useMemo, useState } from 'react';
import { DollarSign, Download, Landmark, LineChart, Percent, PieChart, Save, TrendingUp, Upload, WalletCards } from 'lucide-react';
import {
  amortizationSchedule,
  blackScholes,
  bondAnalytics,
  bondYieldToMaturity,
  capm,
  currency,
  dcfValue,
  futureValue,
  gordonGrowth,
  irr,
  payment,
  percent,
  portfolioStatistics,
  presentValue,
  weightedAverageCostOfCapital,
  xirr,
} from '../lib/financeMath';
import { downloadCsv } from '../lib/exportUtils';
import { recordSkillLabAttempt, saveNote, saveResultArtifact } from '../lib/learning';
import { PageHeader, Panel, Surface } from '../components/ui/Primitives';
import { SourceRail } from '../components/SourceContext';

function NumberField({ label, value, onChange, step = '1', suffix, hidden = false, min, max }) {
  if (hidden) return null;
  const numeric = Number(value);
  const invalid = value !== '' && (!Number.isFinite(numeric) || (min !== undefined && numeric < min) || (max !== undefined && numeric > max));
  return (
    <div className="calc-field">
      <label>{label}</label>
      <div className="input-with-suffix">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          aria-label={label}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          step={step}
        />
        {suffix && <small>{suffix}</small>}
      </div>
      {invalid && <small className="field-error">Check range</small>}
    </div>
  );
}

function ResultCard({ label, value, tone = 'accent' }) {
  return (
    <Surface density="compact" status={tone} className={`calc-result result-card result-card-${tone}`}>
      <small>{label}</small>
      <div className="calc-result-value">{value}</div>
    </Surface>
  );
}

function ValidationPanel({ messages = [] }) {
  if (!messages.length) return null;
  return (
    <div className="validation-panel" role="status">
      {messages.map((message) => <div key={message}>{message}</div>)}
    </div>
  );
}

function scenarioKeyFor(title) {
  return `quantvault:calculator-scenario:${title}`;
}

function calculatorMetadataFor(title) {
  if (/amortization/i.test(title)) {
    return { level: 'level1', topic: 'fixed-income', objectiveIds: ['calculator:amortization-schedule'] };
  }
  if (/irr/i.test(title)) {
    return { level: 'level1', topic: 'quant-methods', objectiveIds: ['calculator:irr-xirr'] };
  }
  if (/black-scholes/i.test(title)) {
    return { level: 'level2', topic: 'derivatives', objectiveIds: ['calculator:black-scholes'] };
  }
  if (/bond/i.test(title)) {
    return { level: 'level1', topic: 'fixed-income', objectiveIds: ['calculator:bond-analytics'] };
  }
  if (/portfolio/i.test(title)) {
    return { level: 'level2', topic: 'portfolio', objectiveIds: ['calculator:portfolio-statistics', 'calculator:capm-gordon-growth'] };
  }
  if (/dcf|wacc/i.test(title)) {
    return { level: 'level2', topic: 'equity', objectiveIds: ['calculator:dcf-wacc'] };
  }
  return { level: 'level1', topic: 'quant-methods', objectiveIds: ['calculator:tvm'] };
}

function AssumptionActions({ title, text, assumptions = {}, metrics = {}, csvRows, scenario, onLoadScenario }) {
  const [message, setMessage] = useState('');

  async function copyAssumptions() {
    await navigator.clipboard?.writeText(text);
    setMessage('Copied');
  }

  async function sendToNotes() {
    const metadata = calculatorMetadataFor(title);
    const artifact = await saveResultArtifact({
      type: 'calculator',
      domain: 'cfa',
      level: metadata.level,
      topic: metadata.topic,
      title,
      summary: text,
      assumptions,
      metrics,
      path: '/calculators',
      objectiveIds: metadata.objectiveIds,
    });
    await recordSkillLabAttempt({
      domain: 'cfa',
      level: metadata.level,
      topic: metadata.topic,
      labId: title,
      labType: 'calculator',
      objectiveIds: metadata.objectiveIds,
      artifactId: artifact.id,
      score: 100,
      elapsedSeconds: 60,
    });
    const note = await saveNote({
      type: 'artifact',
      domain: 'cfa',
      title,
      body: text,
      path: '/calculators',
      artifactId: artifact.id,
    });
    setMessage(`Saved artifact ${new Date(note.updatedAt).toLocaleTimeString()}`);
  }

  function saveScenario() {
    window.localStorage?.setItem(scenarioKeyFor(title), JSON.stringify(scenario || { assumptions, metrics }));
    setMessage('Scenario saved locally');
  }

  function loadScenario() {
    const raw = window.localStorage?.getItem(scenarioKeyFor(title));
    if (!raw || !onLoadScenario) {
      setMessage('No saved scenario');
      return;
    }
    onLoadScenario(JSON.parse(raw));
    setMessage('Scenario loaded');
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
    <div className="qv-row-2" style={{ flexWrap: 'wrap', marginTop: 'var(--space-5)' }}>
      <button className="btn btn-secondary" onClick={copyAssumptions}>Copy Assumptions</button>
      <button className="btn btn-secondary" onClick={sendToNotes}>Send Result to Notes</button>
      <button className="btn btn-secondary" onClick={exportCsv}><Download size={14} /> CSV</button>
      <button className="btn btn-secondary" onClick={saveScenario}><Save size={14} /> Save Scenario</button>
      {onLoadScenario && <button className="btn btn-secondary" onClick={loadScenario}><Upload size={14} /> Load Scenario</button>}
      {message && <span className="qv-text-muted qv-fs-sm">{message}</span>}
    </div>
  );
}

function TVMCalculator() {
  const [mode, setMode] = useState('FV');
  const [pv, setPv] = useState('10000');
  const [fv, setFv] = useState('15000');
  const [rate, setRate] = useState('8');
  const [years, setYears] = useState('5');
  const [pmt, setPmt] = useState('0');
  const [freq, setFreq] = useState('4');

  const result = useMemo(() => {
    const args = {
      presentValue: Number(pv),
      futureValue: Number(fv),
      payment: Number(pmt),
      annualRate: Number(rate) / 100,
      years: Number(years),
      frequency: Number(freq),
    };

    if (mode === 'FV') return { label: 'Future Value', value: futureValue(args) };
    if (mode === 'PV') return { label: 'Present Value', value: presentValue(args) };
    return { label: 'Payment per Period', value: payment(args) };
  }, [fv, mode, pmt, pv, rate, years, freq]);
  const warnings = [
    Number(years) <= 0 && 'Years must be positive.',
    Number(freq) <= 0 && 'Compounding frequency must be positive.',
    Number(rate) <= -100 && 'Rates at or below -100% are not valid.',
  ].filter(Boolean);
  const scenario = { mode, pv, fv, rate, years, pmt, freq };
  function loadScenario(next) {
    setMode(next.mode || 'FV');
    setPv(next.pv ?? pv);
    setFv(next.fv ?? fv);
    setRate(next.rate ?? rate);
    setYears(next.years ?? years);
    setPmt(next.pmt ?? pmt);
    setFreq(next.freq ?? freq);
  }

  return (
    <div>
      <div className="segmented-row">
        {['FV', 'PV', 'PMT'].map((item) => (
          <button key={item} className={`btn ${mode === item ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setMode(item)}>
            Solve for {item}
          </button>
        ))}
      </div>

      <div className="calc-grid">
        <NumberField label="Present Value" value={pv} onChange={setPv} suffix="$" hidden={mode === 'PV'} />
        <NumberField label="Future Value" value={fv} onChange={setFv} suffix="$" hidden={mode === 'FV'} />
        <NumberField label="Annual Rate" value={rate} onChange={setRate} step="0.01" suffix="%" min="-99.99" />
        <NumberField label="Years" value={years} onChange={setYears} step="0.25" min="0.01" />
        <NumberField label="Payment per Period" value={pmt} onChange={setPmt} suffix="$" hidden={mode === 'PMT'} />
        <label className="calc-field">
          <span>Compounding Frequency</span>
          <select value={freq} onChange={(event) => setFreq(event.target.value)}>
            <option value="1">Annual</option>
            <option value="2">Semi-Annual</option>
            <option value="4">Quarterly</option>
            <option value="12">Monthly</option>
            <option value="365">Daily</option>
          </select>
        </label>
      </div>

      <ValidationPanel messages={warnings} />
      <ResultCard label={result.label} value={currency(result.value)} />
      <div className="key-concept" style={{ marginTop: 'var(--space-5)' }}>
        <h4>Sign convention</h4>
        <p className="qv-text-secondary qv-fs-sm qv-m-0">
          Treat cash you invest as an outflow and cash you receive as an inflow when reconciling TVM answers with a financial calculator.
        </p>
      </div>
      <AssumptionActions
        title="TVM calculator result"
        text={`TVM ${mode}: PV ${pv}, FV ${fv}, PMT ${pmt}, rate ${rate}%, years ${years}, frequency ${freq}, result ${result.value}`}
        assumptions={scenario}
        metrics={{ result: result.value }}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

function BlackScholesCalculator() {
  const [spot, setSpot] = useState('100');
  const [strike, setStrike] = useState('100');
  const [years, setYears] = useState('1');
  const [rate, setRate] = useState('5');
  const [vol, setVol] = useState('20');

  const results = useMemo(() => blackScholes({
    spot: Number(spot),
    strike: Number(strike),
    years: Number(years),
    annualRate: Number(rate) / 100,
    volatility: Number(vol) / 100,
  }), [rate, spot, strike, vol, years]);
  const warnings = [
    Number(spot) <= 0 && 'Spot price must be positive.',
    Number(strike) <= 0 && 'Strike price must be positive.',
    Number(years) <= 0 && 'Time to expiry must be positive.',
    Number(vol) <= 0 && 'Volatility must be positive.',
  ].filter(Boolean);
  const scenario = { spot, strike, years, rate, vol };
  function loadScenario(next) {
    setSpot(next.spot ?? spot);
    setStrike(next.strike ?? strike);
    setYears(next.years ?? years);
    setRate(next.rate ?? rate);
    setVol(next.vol ?? vol);
  }

  return (
    <div>
      <div className="calc-grid">
        <NumberField label="Spot Price" value={spot} onChange={setSpot} suffix="$" min="0.01" />
        <NumberField label="Strike Price" value={strike} onChange={setStrike} suffix="$" min="0.01" />
        <NumberField label="Time to Expiry" value={years} onChange={setYears} step="0.01" suffix="years" min="0.01" />
        <NumberField label="Risk-Free Rate" value={rate} onChange={setRate} step="0.1" suffix="%" />
        <NumberField label="Volatility" value={vol} onChange={setVol} step="0.1" suffix="%" min="0.01" />
      </div>
      <ValidationPanel messages={warnings} />

      {results && (
        <>
          <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
            <ResultCard label="Call Price" value={currency(results.call)} tone="success" />
            <ResultCard label="Put Price" value={currency(results.put)} tone="danger" />
          </div>
          <Surface className="metric-grid">
            {[
              ['Delta Call', results.deltaCall.toFixed(4)],
              ['Delta Put', results.deltaPut.toFixed(4)],
              ['Gamma', results.gamma.toFixed(6)],
              ['Theta/day', results.thetaCallPerDay.toFixed(4)],
              ['Vega', results.vega.toFixed(4)],
              ['d1', results.d1.toFixed(4)],
              ['d2', results.d2.toFixed(4)],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </Surface>
          <AssumptionActions
            title="Black-Scholes calculator result"
            text={`Black-Scholes: spot ${spot}, strike ${strike}, years ${years}, rate ${rate}%, volatility ${vol}%, call ${results.call}, put ${results.put}`}
            assumptions={scenario}
            metrics={{ call: results.call, put: results.put, deltaCall: results.deltaCall, gamma: results.gamma }}
            scenario={scenario}
            onLoadScenario={loadScenario}
          />
        </>
      )}
    </div>
  );
}

function BondCalculator() {
  const [face, setFace] = useState('1000');
  const [coupon, setCoupon] = useState('6');
  const [yieldRate, setYieldRate] = useState('5.25');
  const [years, setYears] = useState('7');
  const [freq, setFreq] = useState('2');
  const [marketPrice, setMarketPrice] = useState('1000');
  const result = useMemo(() => bondAnalytics({
    faceValue: Number(face),
    couponRate: Number(coupon) / 100,
    yieldRate: Number(yieldRate) / 100,
    years: Number(years),
    frequency: Number(freq),
  }), [coupon, face, freq, years, yieldRate]);
  const solvedYield = useMemo(() => bondYieldToMaturity({
    price: Number(marketPrice),
    faceValue: Number(face),
    couponRate: Number(coupon) / 100,
    years: Number(years),
    frequency: Number(freq),
  }), [coupon, face, freq, marketPrice, years]);
  const warnings = [
    Number(face) <= 0 && 'Face value must be positive.',
    Number(marketPrice) <= 0 && 'Market price must be positive.',
    Number(years) <= 0 && 'Years to maturity must be positive.',
    Number(freq) <= 0 && 'Coupon frequency must be positive.',
  ].filter(Boolean);
  const scenario = { face, coupon, yieldRate, marketPrice, years, freq };
  function loadScenario(next) {
    setFace(next.face ?? face);
    setCoupon(next.coupon ?? coupon);
    setYieldRate(next.yieldRate ?? yieldRate);
    setMarketPrice(next.marketPrice ?? marketPrice);
    setYears(next.years ?? years);
    setFreq(next.freq ?? freq);
  }

  return (
    <div>
      <div className="calc-grid">
        <NumberField label="Face Value" value={face} onChange={setFace} suffix="$" min="0.01" />
        <NumberField label="Coupon Rate" value={coupon} onChange={setCoupon} step="0.1" suffix="%" />
        <NumberField label="Yield to Maturity" value={yieldRate} onChange={setYieldRate} step="0.1" suffix="%" />
        <NumberField label="Market Price for YTM Solver" value={marketPrice} onChange={setMarketPrice} step="0.01" suffix="$" min="0.01" />
        <NumberField label="Years to Maturity" value={years} onChange={setYears} step="0.5" min="0.01" />
        <label className="calc-field">
          <span>Coupon Frequency</span>
          <select value={freq} onChange={(event) => setFreq(event.target.value)}>
            <option value="1">Annual</option>
            <option value="2">Semi-Annual</option>
            <option value="4">Quarterly</option>
          </select>
        </label>
      </div>
      <ValidationPanel messages={warnings} />
      {result && (
        <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
          <ResultCard label="Clean Price Estimate" value={currency(result.price)} />
          <ResultCard label="Solved YTM" value={percent(solvedYield, 3)} tone="warning" />
          <ResultCard label="Modified Duration" value={result.modifiedDuration.toFixed(3)} tone="warning" />
          <ResultCard label="Macaulay Duration" value={result.macaulayDuration.toFixed(3)} tone="success" />
          <ResultCard label="Convexity" value={result.convexity.toFixed(3)} tone="accent" />
        </div>
      )}
      <AssumptionActions
        title="Bond calculator result"
        text={`Bond: face ${face}, coupon ${coupon}%, input YTM ${yieldRate}%, market price ${marketPrice}, years ${years}, frequency ${freq}, solved YTM ${solvedYield}`}
        assumptions={scenario}
        metrics={{ price: result?.price ?? NaN, solvedYield, modifiedDuration: result?.modifiedDuration ?? NaN, convexity: result?.convexity ?? NaN }}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

function DcfCalculator() {
  const [revenue, setRevenue] = useState('1000');
  const [growth, setGrowth] = useState('8');
  const [margin, setMargin] = useState('18');
  const [terminalGrowth, setTerminalGrowth] = useState('2.5');
  const [equityWeight, setEquityWeight] = useState('70');
  const [debtWeight, setDebtWeight] = useState('30');
  const [costEquity, setCostEquity] = useState('11');
  const [costDebt, setCostDebt] = useState('5.5');
  const [taxRate, setTaxRate] = useState('24');

  const model = useMemo(() => {
    const wacc = weightedAverageCostOfCapital({
      equityWeight: Number(equityWeight),
      debtWeight: Number(debtWeight),
      costOfEquity: Number(costEquity) / 100,
      costOfDebt: Number(costDebt) / 100,
      taxRate: Number(taxRate) / 100,
    });
    const cashFlows = Array.from({ length: 5 }, (_, index) => {
      const sales = Number(revenue) * Math.pow(1 + Number(growth) / 100, index + 1);
      return sales * (Number(margin) / 100) * (1 - Number(taxRate) / 100);
    });
    return { wacc, cashFlows, ...dcfValue({ cashFlows, discountRate: wacc, terminalGrowth: Number(terminalGrowth) / 100 }) };
  }, [costDebt, costEquity, debtWeight, equityWeight, growth, margin, revenue, taxRate, terminalGrowth]);
  const warnings = [
    Number(revenue) <= 0 && 'Starting revenue should be positive.',
    Number(costEquity) <= Number(terminalGrowth) && 'Cost of equity should exceed terminal growth.',
    model.wacc <= Number(terminalGrowth) / 100 && 'WACC must exceed terminal growth for a finite terminal value.',
    Number(equityWeight) + Number(debtWeight) <= 0 && 'Capital structure weights must sum to a positive amount.',
  ].filter(Boolean);
  const scenario = { revenue, growth, margin, terminalGrowth, equityWeight, debtWeight, costEquity, costDebt, taxRate };
  function loadScenario(next) {
    setRevenue(next.revenue ?? revenue);
    setGrowth(next.growth ?? growth);
    setMargin(next.margin ?? margin);
    setTerminalGrowth(next.terminalGrowth ?? terminalGrowth);
    setEquityWeight(next.equityWeight ?? equityWeight);
    setDebtWeight(next.debtWeight ?? debtWeight);
    setCostEquity(next.costEquity ?? costEquity);
    setCostDebt(next.costDebt ?? costDebt);
    setTaxRate(next.taxRate ?? taxRate);
  }

  return (
    <div>
      <div className="calc-grid">
        <NumberField label="Starting Revenue" value={revenue} onChange={setRevenue} suffix="$m" min="0.01" />
        <NumberField label="Revenue Growth" value={growth} onChange={setGrowth} step="0.1" suffix="%" />
        <NumberField label="FCF Margin" value={margin} onChange={setMargin} step="0.1" suffix="%" />
        <NumberField label="Terminal Growth" value={terminalGrowth} onChange={setTerminalGrowth} step="0.1" suffix="%" />
        <NumberField label="Equity Weight" value={equityWeight} onChange={setEquityWeight} suffix="%" />
        <NumberField label="Debt Weight" value={debtWeight} onChange={setDebtWeight} suffix="%" />
        <NumberField label="Cost of Equity" value={costEquity} onChange={setCostEquity} step="0.1" suffix="%" />
        <NumberField label="Cost of Debt" value={costDebt} onChange={setCostDebt} step="0.1" suffix="%" />
        <NumberField label="Tax Rate" value={taxRate} onChange={setTaxRate} step="0.1" suffix="%" />
      </div>
      <ValidationPanel messages={warnings} />
      <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
        <ResultCard label="WACC" value={percent(model.wacc, 2)} tone="warning" />
        <ResultCard label="Enterprise Value" value={currency(model.enterpriseValue, 1)} />
        <ResultCard label="PV Forecast Cash Flows" value={currency(model.pvCashFlows, 1)} tone="success" />
        <ResultCard label="PV Terminal Value" value={currency(model.pvTerminalValue, 1)} tone="accent" />
      </div>
      <AssumptionActions
        title="DCF calculator result"
        text={`DCF: revenue ${revenue}, growth ${growth}%, FCF margin ${margin}%, WACC ${model.wacc}, enterprise value ${model.enterpriseValue}`}
        assumptions={scenario}
        metrics={{ wacc: model.wacc, enterpriseValue: model.enterpriseValue, pvCashFlows: model.pvCashFlows, pvTerminalValue: model.pvTerminalValue }}
        csvRows={[
          ['year', 'cash_flow'],
          ...model.cashFlows.map((cashFlow, index) => [index + 1, cashFlow]),
          ['WACC', model.wacc],
          ['Enterprise Value', model.enterpriseValue],
        ]}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

function AmortizationCalculator() {
  const [principal, setPrincipal] = useState('350000');
  const [rate, setRate] = useState('6.5');
  const [years, setYears] = useState('30');
  const [freq, setFreq] = useState('12');
  const result = useMemo(() => amortizationSchedule({
    principal: Number(principal),
    annualRate: Number(rate) / 100,
    years: Number(years),
    frequency: Number(freq),
  }), [freq, principal, rate, years]);
  const warnings = [
    Number(principal) <= 0 && 'Principal must be positive.',
    Number(years) <= 0 && 'Years must be positive.',
    Number(freq) <= 0 && 'Payments per year must be positive.',
  ].filter(Boolean);
  const scenario = { principal, rate, years, freq };
  function loadScenario(next) {
    setPrincipal(next.principal ?? principal);
    setRate(next.rate ?? rate);
    setYears(next.years ?? years);
    setFreq(next.freq ?? freq);
  }

  return (
    <div>
      <div className="calc-grid">
        <NumberField label="Principal" value={principal} onChange={setPrincipal} suffix="$" min="0.01" />
        <NumberField label="Annual Rate" value={rate} onChange={setRate} step="0.1" suffix="%" />
        <NumberField label="Years" value={years} onChange={setYears} step="1" min="0.01" />
        <NumberField label="Payments per Year" value={freq} onChange={setFreq} step="1" min="1" />
      </div>
      <ValidationPanel messages={warnings} />
      <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
        <ResultCard label="Payment" value={currency(result.payment)} />
        <ResultCard label="Total Interest" value={currency(result.totalInterest)} tone="warning" />
      </div>
      <Surface className="metric-grid">
        {result.rows.slice(0, 4).map((row) => (
          <div key={row.period}>
            <small>Period {row.period}</small>
            <strong>{currency(row.balance, 0)}</strong>
          </div>
        ))}
      </Surface>
      <AssumptionActions
        title="Amortization result"
        text={`Amortization: principal ${principal}, rate ${rate}%, years ${years}, frequency ${freq}, payment ${result.payment}, total interest ${result.totalInterest}`}
        assumptions={scenario}
        metrics={{ payment: result.payment, totalInterest: result.totalInterest }}
        csvRows={[
          ['period', 'payment', 'interest', 'principal', 'balance'],
          ...result.rows.map((row) => [row.period, row.payment, row.interest, row.principal, row.balance]),
        ]}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

function IrrCalculator() {
  const [flows, setFlows] = useState('-1000, 350, 375, 425, 450');
  const [dates, setDates] = useState('2026-01-01, 2026-10-01, 2027-08-15, 2028-02-01, 2029-01-01');
  const cashFlows = useMemo(() => flows.split(',').map((value) => Number(value.trim())), [flows]);
  const dateList = useMemo(() => dates.split(',').map((value) => value.trim()), [dates]);
  const periodicIrr = useMemo(() => irr(cashFlows), [cashFlows]);
  const datedIrr = useMemo(() => xirr(cashFlows, dateList), [cashFlows, dateList]);
  const warnings = [
    cashFlows.some((value) => !Number.isFinite(value)) && 'Cash flows must be comma-separated numbers.',
    cashFlows.length !== dateList.length && 'XIRR needs one date for each cash flow.',
    !cashFlows.some((value) => value < 0) || !cashFlows.some((value) => value > 0) ? 'IRR requires at least one inflow and one outflow.' : false,
  ].filter(Boolean);
  const scenario = { flows, dates };
  function loadScenario(next) {
    setFlows(next.flows ?? flows);
    setDates(next.dates ?? dates);
  }

  return (
    <div>
      <label className="calc-field">
        <span>Cash Flows</span>
        <textarea value={flows} onChange={(event) => setFlows(event.target.value)} rows={3} />
      </label>
      <label className="calc-field" style={{ marginTop: 'var(--space-4)' }}>
        <span>Dates for XIRR</span>
        <textarea value={dates} onChange={(event) => setDates(event.target.value)} rows={3} />
      </label>
      <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
        <ResultCard label="Periodic IRR" value={percent(periodicIrr, 2)} />
        <ResultCard label="Dated XIRR" value={percent(datedIrr, 2)} tone="success" />
      </div>
      <ValidationPanel messages={warnings} />
      <AssumptionActions
        title="IRR result"
        text={`Cash flows ${flows}; dates ${dates}; IRR ${periodicIrr}; XIRR ${datedIrr}`}
        assumptions={scenario}
        metrics={{ periodicIrr, datedIrr }}
        csvRows={[
          ['date', 'cash_flow'],
          ...cashFlows.map((cashFlow, index) => [dateList[index] || '', cashFlow]),
          ['IRR', periodicIrr],
          ['XIRR', datedIrr],
        ]}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

function PortfolioCalculator() {
  const [weights, setWeights] = useState('60,40');
  const [returns, setReturns] = useState('10,4');
  const [vols, setVols] = useState('18,7');
  const [corr, setCorr] = useState('0.20');
  const [riskFree, setRiskFree] = useState('3');
  const [beta, setBeta] = useState('1.2');
  const [marketReturn, setMarketReturn] = useState('8');
  const [dividend, setDividend] = useState('2');
  const [requiredReturn, setRequiredReturn] = useState('10');
  const [growth, setGrowth] = useState('4');

  const model = useMemo(() => {
    const weightValues = weights.split(',').map((value) => Number(value.trim()) / 100);
    const returnValues = returns.split(',').map((value) => Number(value.trim()) / 100);
    const volValues = vols.split(',').map((value) => Number(value.trim()) / 100);
    const correlation = Number(corr);
    const stats = portfolioStatistics({
      weights: weightValues,
      expectedReturns: returnValues,
      volatilities: volValues,
      correlationMatrix: [
        [1, correlation],
        [correlation, 1],
      ],
      riskFreeRate: Number(riskFree) / 100,
    });
    return {
      stats,
      capmReturn: capm({ riskFreeRate: Number(riskFree) / 100, beta: Number(beta), marketReturn: Number(marketReturn) / 100 }),
      gordonValue: gordonGrowth({ dividendNext: Number(dividend), requiredReturn: Number(requiredReturn) / 100, growthRate: Number(growth) / 100 }),
    };
  }, [beta, corr, dividend, growth, marketReturn, requiredReturn, returns, riskFree, vols, weights]);
  const parsedWeights = weights.split(',').map((value) => Number(value.trim()));
  const parsedReturns = returns.split(',').map((value) => Number(value.trim()));
  const parsedVols = vols.split(',').map((value) => Number(value.trim()));
  const warnings = [
    [parsedWeights, parsedReturns, parsedVols].some((list) => list.some((value) => !Number.isFinite(value))) && 'Weights, returns, and volatilities must be numeric comma-separated lists.',
    parsedWeights.length !== parsedReturns.length || parsedWeights.length !== parsedVols.length ? 'Portfolio lists should have matching lengths.' : false,
    parsedWeights.length !== 2 && 'This calculator supports exactly two assets. Use a full covariance model before entering three or more assets.',
    Math.abs(Number(corr)) > 1 && 'Correlation should be between -1 and 1.',
    Number(requiredReturn) <= Number(growth) && 'Required return must exceed dividend growth for Gordon Growth.',
  ].filter(Boolean);
  const scenario = { weights, returns, vols, corr, riskFree, beta, marketReturn, dividend, requiredReturn, growth };
  function loadScenario(next) {
    setWeights(next.weights ?? weights);
    setReturns(next.returns ?? returns);
    setVols(next.vols ?? vols);
    setCorr(next.corr ?? corr);
    setRiskFree(next.riskFree ?? riskFree);
    setBeta(next.beta ?? beta);
    setMarketReturn(next.marketReturn ?? marketReturn);
    setDividend(next.dividend ?? dividend);
    setRequiredReturn(next.requiredReturn ?? requiredReturn);
    setGrowth(next.growth ?? growth);
  }

  return (
    <div>
      <div className="calc-grid">
        <NumberField label="Risk-Free Rate" value={riskFree} onChange={setRiskFree} step="0.1" suffix="%" />
        <NumberField label="Beta" value={beta} onChange={setBeta} step="0.1" />
        <NumberField label="Expected Market Return" value={marketReturn} onChange={setMarketReturn} step="0.1" suffix="%" />
        <NumberField label="Next Dividend" value={dividend} onChange={setDividend} step="0.1" suffix="$" />
        <NumberField label="Required Return" value={requiredReturn} onChange={setRequiredReturn} step="0.1" suffix="%" />
        <NumberField label="Dividend Growth" value={growth} onChange={setGrowth} step="0.1" suffix="%" />
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <label className="calc-field">
          <span>Portfolio Weights (%)</span>
          <input value={weights} onChange={(event) => setWeights(event.target.value)} />
        </label>
        <label className="calc-field">
          <span>Expected Returns (%)</span>
          <input value={returns} onChange={(event) => setReturns(event.target.value)} />
        </label>
        <label className="calc-field">
          <span>Volatilities (%)</span>
          <input value={vols} onChange={(event) => setVols(event.target.value)} />
        </label>
        <NumberField label="Two-Asset Correlation" value={corr} onChange={setCorr} step="0.05" min="-1" max="1" />
      </div>
      <ValidationPanel messages={warnings} />
      <div className="grid-2" style={{ marginTop: 'var(--space-6)' }}>
        <ResultCard label="Portfolio Return" value={percent(model.stats?.expectedReturn ?? NaN, 2)} />
        <ResultCard label="Portfolio Volatility" value={percent(model.stats?.volatility ?? NaN, 2)} tone="warning" />
        <ResultCard label="Sharpe Ratio" value={(model.stats?.sharpe ?? NaN).toFixed(3)} tone="success" />
        <ResultCard label="CAPM Expected Return" value={percent(model.capmReturn, 2)} />
        <ResultCard label="Gordon Growth Value" value={currency(model.gordonValue)} tone="accent" />
      </div>
      <AssumptionActions
        title="Portfolio calculator result"
        text={`Portfolio weights ${weights}; returns ${returns}; volatilities ${vols}; corr ${corr}; CAPM ${model.capmReturn}; Gordon ${model.gordonValue}`}
        assumptions={scenario}
        metrics={{ expectedReturn: model.stats?.expectedReturn ?? NaN, volatility: model.stats?.volatility ?? NaN, sharpe: model.stats?.sharpe ?? NaN, capmReturn: model.capmReturn, gordonValue: model.gordonValue }}
        scenario={scenario}
        onLoadScenario={loadScenario}
      />
    </div>
  );
}

export default function Calculators() {
  const [active, setActive] = useState('tvm');
  const calculators = [
    { id: 'tvm', label: 'TVM Calculator', icon: DollarSign, desc: 'Time value of money' },
    { id: 'amortization', label: 'Amortization', icon: WalletCards, desc: 'Loan schedule and interest' },
    { id: 'irr', label: 'IRR / XIRR', icon: Percent, desc: 'Periodic and dated returns' },
    { id: 'bs', label: 'Black-Scholes', icon: TrendingUp, desc: 'Options pricing and Greeks' },
    { id: 'bond', label: 'Bond Analytics', icon: Landmark, desc: 'Price, duration, convexity' },
    { id: 'portfolio', label: 'Portfolio / Equity', icon: PieChart, desc: 'CAPM, stats, Gordon Growth' },
    { id: 'dcf', label: 'DCF / WACC', icon: LineChart, desc: 'Valuation sensitivity' },
  ];
  const activeCalc = calculators.find((calc) => calc.id === active);
  const calculatorSourceTarget = {
    kind: 'tool',
    domain: 'cfa',
    level: active === 'bs' || active === 'portfolio' || active === 'dcf' ? 'level2' : 'level1',
    topicId: active === 'bond' ? 'fixed-income' : active === 'bs' ? 'derivatives' : active === 'portfolio' || active === 'dcf' ? 'equity' : 'quant-methods',
    title: activeCalc?.label || 'Financial calculator',
    formulaNames: [activeCalc?.label].filter(Boolean),
    keywords: [activeCalc?.desc, active].filter(Boolean),
    route: '/calculators',
  };

  return (
    <div className="page-container">
      <PageHeader
        badge="CALCULATORS"
        title="Financial Calculators"
        subtitle="Interactive tools for valuation, options, fixed income, portfolio analysis, and local result artifacts."
      />

      <div className="tool-layout">
        <div className="tool-tabs tool-tabs-surface">
          {calculators.map((calc) => (
            <button key={calc.id} className={`sidebar-link ${active === calc.id ? 'active' : ''}`} onClick={() => setActive(calc.id)}>
              <calc.icon size={18} />
              <span>
                <strong>{calc.label}</strong>
                <small>{calc.desc}</small>
              </span>
            </button>
          ))}
        </div>

        <Panel title={activeCalc?.label} tone="default" className="calc-container calc-workbench">
          <SourceRail compact limit={2} title="Tool Source Context" target={calculatorSourceTarget} />
          {active === 'tvm' && <TVMCalculator />}
          {active === 'amortization' && <AmortizationCalculator />}
          {active === 'irr' && <IrrCalculator />}
          {active === 'bs' && <BlackScholesCalculator />}
          {active === 'bond' && <BondCalculator />}
          {active === 'portfolio' && <PortfolioCalculator />}
          {active === 'dcf' && <DcfCalculator />}
        </Panel>
      </div>
    </div>
  );
}
