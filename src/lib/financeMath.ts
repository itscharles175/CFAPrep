export type Numeric = number | string | null | undefined;

export interface TimeValueInput {
  presentValue?: number;
  futureValue?: number;
  payment?: number;
  annualRate?: number;
  years?: number;
  frequency?: number;
}

export function toFiniteNumber(value: Numeric, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function periodicRate(annualRate: Numeric, frequency: Numeric = 1): number {
  const periodsPerYear = Math.max(1, toFiniteNumber(frequency, 1));
  return toFiniteNumber(annualRate, 0) / periodsPerYear;
}

export function periodCount(years: Numeric, frequency: Numeric = 1): number {
  return Math.max(0, toFiniteNumber(years, 0) * Math.max(1, toFiniteNumber(frequency, 1)));
}

function futureAnnuityFactor(rate: number, periods: number): number {
  if (periods === 0) return 0;
  if (rate === 0) return periods;
  return (Math.pow(1 + rate, periods) - 1) / rate;
}

function presentAnnuityFactor(rate: number, periods: number): number {
  if (periods === 0) return 0;
  if (rate === 0) return periods;
  return (1 - Math.pow(1 + rate, -periods)) / rate;
}

export function futureValue({ presentValue = 0, payment = 0, annualRate = 0, years = 0, frequency = 1 }: TimeValueInput): number {
  const rate = periodicRate(annualRate, frequency);
  const periods = periodCount(years, frequency);
  return presentValue * Math.pow(1 + rate, periods) + payment * futureAnnuityFactor(rate, periods);
}

export function presentValue({ futureValue: fv = 0, payment = 0, annualRate = 0, years = 0, frequency = 1 }: TimeValueInput): number {
  const rate = periodicRate(annualRate, frequency);
  const periods = periodCount(years, frequency);
  return fv / Math.pow(1 + rate, periods) + payment * presentAnnuityFactor(rate, periods);
}

export function payment({ presentValue: pv = 0, futureValue: fv = 0, annualRate = 0, years = 0, frequency = 1 }: TimeValueInput): number {
  const rate = periodicRate(annualRate, frequency);
  const periods = periodCount(years, frequency);
  if (periods === 0) return NaN;
  if (rate === 0) return (fv - pv) / periods;
  return (fv - pv * Math.pow(1 + rate, periods)) / futureAnnuityFactor(rate, periods);
}

export function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z));
  return 0.5 * (1 + sign * erf);
}

export interface BlackScholesInput {
  spot: Numeric;
  strike: Numeric;
  years: Numeric;
  annualRate: Numeric;
  volatility: Numeric;
}

export interface BlackScholesResult {
  call: number;
  put: number;
  d1: number;
  d2: number;
  deltaCall: number;
  deltaPut: number;
  gamma: number;
  thetaCallPerDay: number;
  thetaPutPerDay: number;
  vega: number;
}

export function blackScholes({ spot, strike, years, annualRate, volatility }: BlackScholesInput): BlackScholesResult | null {
  const s = toFiniteNumber(spot, NaN);
  const k = toFiniteNumber(strike, NaN);
  const t = toFiniteNumber(years, NaN);
  const r = toFiniteNumber(annualRate, NaN);
  const vol = toFiniteNumber(volatility, NaN);

  if (s <= 0 || k <= 0 || t <= 0 || vol <= 0 || !Number.isFinite(r)) {
    return null;
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + (vol * vol) / 2) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discount = Math.exp(-r * t);
  const call = s * normalCdf(d1) - k * discount * normalCdf(d2);
  const put = k * discount * normalCdf(-d2) - s * normalCdf(-d1);
  const pdfD1 = normalPdf(d1);

  return {
    call,
    put,
    d1,
    d2,
    deltaCall: normalCdf(d1),
    deltaPut: normalCdf(d1) - 1,
    gamma: pdfD1 / (s * vol * sqrtT),
    thetaCallPerDay: (-(s * pdfD1 * vol) / (2 * sqrtT) - r * k * discount * normalCdf(d2)) / 365,
    thetaPutPerDay: (-(s * pdfD1 * vol) / (2 * sqrtT) + r * k * discount * normalCdf(-d2)) / 365,
    vega: (s * pdfD1 * sqrtT) / 100,
  };
}

export interface BondAnalyticsInput {
  faceValue?: Numeric;
  couponRate?: Numeric;
  yieldRate?: Numeric;
  years?: Numeric;
  frequency?: Numeric;
}

export interface BondAnalyticsResult {
  price: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
}

export function bondAnalytics({ faceValue = 1000, couponRate = 0.05, yieldRate = 0.05, years = 5, frequency = 2 }: BondAnalyticsInput): BondAnalyticsResult | null {
  const face = toFiniteNumber(faceValue, 1000);
  const coupon = face * toFiniteNumber(couponRate, 0) / Math.max(1, toFiniteNumber(frequency, 1));
  const y = periodicRate(yieldRate, frequency);
  const periods = Math.round(periodCount(years, frequency));

  if (face <= 0 || periods <= 0) return null;

  let price = 0;
  let weightedPv = 0;
  let convexityNumerator = 0;

  for (let i = 1; i <= periods; i += 1) {
    const cashFlow = coupon + (i === periods ? face : 0);
    const discount = Math.pow(1 + y, i);
    const pv = cashFlow / discount;
    const yearsAtCashFlow = i / Math.max(1, toFiniteNumber(frequency, 1));
    price += pv;
    weightedPv += yearsAtCashFlow * pv;
    convexityNumerator += yearsAtCashFlow * (yearsAtCashFlow + 1 / Math.max(1, toFiniteNumber(frequency, 1))) * pv;
  }

  const macaulayDuration = weightedPv / price;
  const modifiedDuration = macaulayDuration / (1 + y);
  const convexity = convexityNumerator / (price * Math.pow(1 + y, 2));

  return { price, macaulayDuration, modifiedDuration, convexity };
}

export interface BondYieldInput {
  price?: Numeric;
  faceValue?: Numeric;
  couponRate?: Numeric;
  years?: Numeric;
  frequency?: Numeric;
}

export function bondYieldToMaturity({ price = 1000, faceValue = 1000, couponRate = 0.05, years = 5, frequency = 2 }: BondYieldInput): number {
  const target = toFiniteNumber(price, NaN);
  if (!Number.isFinite(target) || target <= 0) return NaN;

  let low = -0.95;
  let high = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const analytics = bondAnalytics({ faceValue, couponRate, yieldRate: mid, years, frequency });
    if (!analytics) return NaN;
    if (analytics.price > target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export interface AmortizationInput {
  principal?: Numeric;
  annualRate?: Numeric;
  years?: Numeric;
  frequency?: Numeric;
}

export interface AmortizationRow {
  period: number;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export interface AmortizationResult {
  payment: number;
  totalInterest: number;
  rows: AmortizationRow[];
}

export function amortizationSchedule({ principal = 100000, annualRate = 0.06, years = 30, frequency = 12 }: AmortizationInput): AmortizationResult {
  const balanceStart = toFiniteNumber(principal, 0);
  const rate = periodicRate(annualRate, frequency);
  const periods = Math.round(periodCount(years, frequency));
  if (balanceStart <= 0 || periods <= 0) return { payment: 0, totalInterest: 0, rows: [] };

  const paymentAmount =
    rate === 0
      ? balanceStart / periods
      : (balanceStart * rate) / (1 - Math.pow(1 + rate, -periods));

  let balance = balanceStart;
  let totalInterest = 0;
  const rows: AmortizationRow[] = [];
  for (let period = 1; period <= periods; period += 1) {
    const interest = balance * rate;
    const principalPaid = Math.min(balance, paymentAmount - interest);
    balance = Math.max(0, balance - principalPaid);
    totalInterest += interest;
    rows.push({
      period,
      payment: paymentAmount,
      interest,
      principal: principalPaid,
      balance,
    });
  }

  return { payment: paymentAmount, totalInterest, rows };
}

export function npv(rate: number, cashFlows: Numeric[] = []): number {
  return cashFlows.reduce((sum: number, cashFlow, index) => sum + toFiniteNumber(cashFlow, 0) / Math.pow(1 + rate, index), 0);
}

export function irr(cashFlows: Numeric[] = [], guess = 0.1): number {
  const flows = cashFlows.map((value) => toFiniteNumber(value, 0));
  const hasPositive = flows.some((value) => value > 0);
  const hasNegative = flows.some((value) => value < 0);
  if (!hasPositive || !hasNegative) return NaN;

  let rate = guess;
  for (let i = 0; i < 60; i += 1) {
    const value = npv(rate, flows);
    const derivative = flows.reduce((sum, cashFlow, index) => {
      if (index === 0) return sum;
      return sum - (index * cashFlow) / Math.pow(1 + rate, index + 1);
    }, 0);
    if (Math.abs(derivative) < 1e-10) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-8) return next;
    rate = next;
  }

  let low = -0.9999;
  let high = 10;
  for (let i = 0; i < 120; i += 1) {
    const mid = (low + high) / 2;
    const value = npv(mid, flows);
    if (value > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function xirr(cashFlows: Numeric[] = [], dates: Array<string | number | Date> = [], guess = 0.1): number {
  if (cashFlows.length !== dates.length || cashFlows.length < 2) return NaN;
  const flows = cashFlows.map((value) => toFiniteNumber(value, 0));
  const hasPositive = flows.some((value) => value > 0);
  const hasNegative = flows.some((value) => value < 0);
  if (!hasPositive || !hasNegative) return NaN;
  const start = new Date(dates[0]).getTime();
  if (!Number.isFinite(start)) return NaN;
  const yearFractions = dates.map((date) => (new Date(date).getTime() - start) / (365 * 24 * 60 * 60 * 1000));
  if (yearFractions.some((value) => !Number.isFinite(value))) return NaN;

  function valueAt(rate: number): number {
    if (rate <= -0.999999) return NaN;
    return flows.reduce((sum, cashFlow, index) => sum + cashFlow / Math.pow(1 + rate, yearFractions[index]), 0);
  }

  let rate = guess;
  for (let i = 0; i < 80; i += 1) {
    const value = valueAt(rate);
    if (!Number.isFinite(value)) break;
    if (Math.abs(value) < 1e-7) return rate;
    const derivative = flows.reduce((sum, cashFlow, index) => {
      const t = yearFractions[index];
      return sum - (t * cashFlow) / Math.pow(1 + rate, t + 1);
    }, 0);
    if (Math.abs(derivative) < 1e-10) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-8 && Math.abs(valueAt(next)) < 1e-6) return next;
    rate = next;
  }

  const candidates = [-0.9999, -0.95, -0.75, -0.5, -0.25, -0.1, 0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  for (let index = 0; index < candidates.length - 1; index += 1) {
    let low = candidates[index];
    let high = candidates[index + 1];
    let lowValue = valueAt(low);
    let highValue = valueAt(high);
    if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || lowValue * highValue > 0) continue;
    for (let step = 0; step < 120; step += 1) {
      const mid = (low + high) / 2;
      const midValue = valueAt(mid);
      if (!Number.isFinite(midValue)) break;
      if (Math.abs(midValue) < 1e-7) return mid;
      if (lowValue * midValue <= 0) {
        high = mid;
      } else {
        low = mid;
        lowValue = midValue;
      }
    }
    const result = (low + high) / 2;
    return Math.abs(valueAt(result)) < 1e-5 ? result : NaN;
  }

  return NaN;
}

export interface CapmInput {
  riskFreeRate?: Numeric;
  beta?: Numeric;
  marketReturn?: Numeric;
}

export function capm({ riskFreeRate = 0.03, beta = 1, marketReturn = 0.08 }: CapmInput): number {
  return toFiniteNumber(riskFreeRate, 0) + toFiniteNumber(beta, 1) * (toFiniteNumber(marketReturn, 0) - toFiniteNumber(riskFreeRate, 0));
}

export interface GordonGrowthInput {
  dividendNext?: Numeric;
  requiredReturn?: Numeric;
  growthRate?: Numeric;
}

export function gordonGrowth({ dividendNext = 1, requiredReturn = 0.1, growthRate = 0.03 }: GordonGrowthInput): number {
  const r = toFiniteNumber(requiredReturn, NaN);
  const g = toFiniteNumber(growthRate, NaN);
  if (!Number.isFinite(r) || !Number.isFinite(g) || r <= g) return NaN;
  return toFiniteNumber(dividendNext, 0) / (r - g);
}

export interface PortfolioStatisticsInput {
  weights?: Numeric[];
  expectedReturns?: Numeric[];
  volatilities?: Numeric[];
  correlationMatrix?: Numeric[][];
  riskFreeRate?: Numeric;
}

export interface PortfolioStatisticsResult {
  weights: number[];
  expectedReturn: number;
  variance: number;
  volatility: number;
  sharpe: number;
}

export function portfolioStatistics({ weights = [], expectedReturns = [], volatilities = [], correlationMatrix = [], riskFreeRate = 0 }: PortfolioStatisticsInput): PortfolioStatisticsResult | null {
  const n = Math.min(weights.length, expectedReturns.length, volatilities.length);
  if (n === 0) return null;
  if (correlationMatrix.length !== n || correlationMatrix.some((row) => !Array.isArray(row) || row.length !== n)) return null;
  const rawWeights = weights.slice(0, n).map((value) => toFiniteNumber(value, 0));
  const totalWeight = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  const normalizedWeights = rawWeights.map((value) => value / totalWeight);
  const returns = expectedReturns.slice(0, n).map((value) => toFiniteNumber(value, 0));
  const vols = volatilities.slice(0, n).map((value) => Math.max(0, toFiniteNumber(value, 0)));
  const expectedReturn = normalizedWeights.reduce((sum, weight, index) => sum + weight * returns[index], 0);

  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const corr = i === j ? 1 : toFiniteNumber(correlationMatrix[i]?.[j], NaN);
      if (!Number.isFinite(corr) || corr < -1 || corr > 1) return null;
      variance += normalizedWeights[i] * normalizedWeights[j] * vols[i] * vols[j] * corr;
    }
  }
  const volatility = Math.sqrt(Math.max(0, variance));
  const sharpe = volatility > 0 ? (expectedReturn - toFiniteNumber(riskFreeRate, 0)) / volatility : NaN;

  return {
    weights: normalizedWeights,
    expectedReturn,
    variance,
    volatility,
    sharpe,
  };
}

export interface BinomialOptionInput {
  spot?: Numeric;
  strike?: Numeric;
  years?: Numeric;
  annualRate?: Numeric;
  volatility?: Numeric;
  steps?: Numeric;
  type?: 'call' | 'put';
}

export interface BinomialTreeNode {
  step: number;
  values: number[];
}

export interface BinomialOptionResult {
  price: number;
  up: number;
  down: number;
  probability: number;
  tree: BinomialTreeNode[];
}

export function binomialOptionPrice({
  spot = 100,
  strike = 100,
  years = 1,
  annualRate = 0.05,
  volatility = 0.2,
  steps = 3,
  type = 'call',
}: BinomialOptionInput): BinomialOptionResult | null {
  const s = toFiniteNumber(spot, NaN);
  const k = toFiniteNumber(strike, NaN);
  const t = toFiniteNumber(years, NaN);
  const r = toFiniteNumber(annualRate, NaN);
  const vol = toFiniteNumber(volatility, NaN);
  const n = Math.max(1, Math.min(100, Math.round(toFiniteNumber(steps, 3))));
  if (s <= 0 || k <= 0 || t <= 0 || vol <= 0 || !Number.isFinite(r)) return null;

  const dt = t / n;
  const up = Math.exp(vol * Math.sqrt(dt));
  const down = 1 / up;
  const discount = Math.exp(-r * dt);
  const probability = (Math.exp(r * dt) - down) / (up - down);
  if (probability < 0 || probability > 1) return null;
  const payoff = (price: number): number => (type === 'put' ? Math.max(0, k - price) : Math.max(0, price - k));
  let values = Array.from({ length: n + 1 }, (_, index) => payoff(s * Math.pow(up, n - index) * Math.pow(down, index)));
  const tree: BinomialTreeNode[] = [{ step: n, values: values.map((value) => Number(value.toFixed(4))) }];
  for (let step = n - 1; step >= 0; step -= 1) {
    values = Array.from({ length: step + 1 }, (_, index) => discount * (probability * values[index] + (1 - probability) * values[index + 1]));
    tree.unshift({ step, values: values.map((value) => Number(value.toFixed(4))) });
  }
  return { price: values[0], up, down, probability, tree };
}

export interface ParametricVarInput {
  portfolioValue?: Numeric;
  annualVolatility?: Numeric;
  days?: Numeric;
  confidence?: Numeric;
}

export interface ParametricVarResult {
  varValue: number;
  cvarValue: number;
  horizonVol: number;
  z: number;
  confidence: number;
}

export function parametricVarCvar({ portfolioValue = 1000000, annualVolatility = 0.18, days = 10, confidence = 0.95 }: ParametricVarInput): ParametricVarResult | null {
  const value = toFiniteNumber(portfolioValue, NaN);
  const vol = toFiniteNumber(annualVolatility, NaN);
  const horizonDays = Math.max(1, toFiniteNumber(days, 10));
  const alpha = Math.min(0.999, Math.max(0.5, toFiniteNumber(confidence, 0.95)));
  if (value <= 0 || vol < 0) return null;
  const z = alpha >= 0.99 ? 2.326347874 : alpha >= 0.975 ? 1.959963985 : 1.644853627;
  const horizonVol = (vol / Math.sqrt(252)) * Math.sqrt(horizonDays);
  const varValue = value * z * horizonVol;
  const cvarValue = value * (normalPdf(z) / (1 - alpha)) * horizonVol;
  return { varValue, cvarValue, horizonVol, z, confidence: alpha };
}

export interface DurationShockInput {
  price?: Numeric;
  modifiedDuration?: Numeric;
  convexity?: Numeric;
  shockBps?: Numeric;
}

export interface DurationShockResult {
  pctChange: number;
  priceChange: number;
  shockedPrice: number;
}

export function durationShock({
  price = 100,
  modifiedDuration = 5,
  convexity = 30,
  shockBps = 100,
}: DurationShockInput): DurationShockResult | null {
  const p = toFiniteNumber(price, NaN);
  const duration = toFiniteNumber(modifiedDuration, NaN);
  const conv = toFiniteNumber(convexity, 0);
  const dy = toFiniteNumber(shockBps, 0) / 10000;
  if (p <= 0 || !Number.isFinite(duration)) return null;
  const pctChange = -duration * dy + 0.5 * conv * dy * dy;
  return {
    pctChange,
    priceChange: p * pctChange,
    shockedPrice: p * (1 + pctChange),
  };
}

export interface WaccInput {
  equityWeight: Numeric;
  debtWeight: Numeric;
  costOfEquity: Numeric;
  costOfDebt: Numeric;
  taxRate: Numeric;
}

export function weightedAverageCostOfCapital({ equityWeight, debtWeight, costOfEquity, costOfDebt, taxRate }: WaccInput): number {
  const e = toFiniteNumber(equityWeight, 0);
  const d = toFiniteNumber(debtWeight, 0);
  const total = e + d || 1;
  return (e / total) * toFiniteNumber(costOfEquity, 0) + (d / total) * toFiniteNumber(costOfDebt, 0) * (1 - toFiniteNumber(taxRate, 0));
}

export interface DcfInput {
  cashFlows?: Numeric[];
  discountRate?: Numeric;
  terminalGrowth?: Numeric;
}

export interface DcfResult {
  pvCashFlows: number;
  terminalValue: number;
  pvTerminalValue: number;
  enterpriseValue: number;
}

export function dcfValue({ cashFlows = [], discountRate = 0.1, terminalGrowth = 0.02 }: DcfInput): DcfResult {
  const r = toFiniteNumber(discountRate, 0.1);
  const g = toFiniteNumber(terminalGrowth, 0.02);
  const flows = cashFlows.map((value) => toFiniteNumber(value, 0));

  const pvCashFlows = flows.reduce((sum, cashFlow, index) => sum + cashFlow / Math.pow(1 + r, index + 1), 0);
  const lastCashFlow = flows.at(-1) || 0;
  const terminalValue = r > g ? (lastCashFlow * (1 + g)) / (r - g) : NaN;
  const pvTerminalValue = Number.isFinite(terminalValue) ? terminalValue / Math.pow(1 + r, flows.length) : NaN;

  return {
    pvCashFlows,
    terminalValue,
    pvTerminalValue,
    enterpriseValue: pvCashFlows + pvTerminalValue,
  };
}

export function currency(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function percent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}
