import { describe, expect, it } from 'vitest';
import {
  blackScholes,
  binomialOptionPrice,
  bondAnalytics,
  bondYieldToMaturity,
  amortizationSchedule,
  capm,
  dcfValue,
  durationShock,
  futureValue,
  gordonGrowth,
  irr,
  parametricVarCvar,
  portfolioStatistics,
  weightedAverageCostOfCapital,
  xirr,
} from './financeMath';

describe('finance math', () => {
  it('compounds quarterly cash correctly', () => {
    expect(futureValue({ presentValue: 10000, annualRate: 0.08, years: 5, frequency: 4 })).toBeCloseTo(14859.47, 2);
  });

  it('prices a benchmark Black-Scholes option', () => {
    const result = blackScholes({ spot: 100, strike: 100, years: 1, annualRate: 0.05, volatility: 0.2 });
    expect(result.call).toBeCloseTo(10.45, 2);
    expect(result.put).toBeCloseTo(5.57, 2);
    expect(result.deltaCall).toBeGreaterThan(0.63);
  });

  it('prices a par coupon bond near face value when coupon equals yield', () => {
    const result = bondAnalytics({ faceValue: 1000, couponRate: 0.06, yieldRate: 0.06, years: 5, frequency: 2 });
    expect(result.price).toBeCloseTo(1000, 2);
    expect(result.modifiedDuration).toBeGreaterThan(3);
  });

  it('computes WACC and DCF terminal value', () => {
    const wacc = weightedAverageCostOfCapital({
      equityWeight: 70,
      debtWeight: 30,
      costOfEquity: 0.11,
      costOfDebt: 0.055,
      taxRate: 0.24,
    });
    expect(wacc).toBeCloseTo(0.08954, 4);

    const dcf = dcfValue({ cashFlows: [100, 112, 125, 137, 150], discountRate: 0.09, terminalGrowth: 0.025 });
    expect(dcf.enterpriseValue).toBeGreaterThan(2000);
  });

  it('solves amortization, IRR, CAPM, Gordon Growth, and portfolio stats', () => {
    const schedule = amortizationSchedule({ principal: 100000, annualRate: 0.06, years: 30, frequency: 12 });
    expect(schedule.payment).toBeCloseTo(599.55, 2);
    expect(schedule.rows.at(-1).balance).toBeCloseTo(0, 2);

    expect(irr([-1000, 400, 400, 400])).toBeCloseTo(0.097, 2);
    expect(xirr([-1000, 1120], ['2026-01-01', '2027-01-01'])).toBeCloseTo(0.12, 2);
    expect(capm({ riskFreeRate: 0.03, beta: 1.2, marketReturn: 0.08 })).toBeCloseTo(0.09, 4);
    expect(gordonGrowth({ dividendNext: 2, requiredReturn: 0.1, growthRate: 0.04 })).toBeCloseTo(33.33, 2);

    const stats = portfolioStatistics({
      weights: [0.6, 0.4],
      expectedReturns: [0.1, 0.04],
      volatilities: [0.18, 0.07],
      correlationMatrix: [
        [1, 0.2],
        [0.2, 1],
      ],
      riskFreeRate: 0.03,
    });
    expect(stats.expectedReturn).toBeCloseTo(0.076, 3);
    expect(stats.volatility).toBeLessThan(0.13);
    expect(stats.sharpe).toBeGreaterThan(0.3);
  });

  it('solves yield to maturity from price', () => {
    const ytm = bondYieldToMaturity({ price: 1000, faceValue: 1000, couponRate: 0.06, years: 5, frequency: 2 });
    expect(ytm).toBeCloseTo(0.06, 4);
  });

  it('supports CFA skill-lab math for trees, tail risk, and duration shocks', () => {
    const tree = binomialOptionPrice({ spot: 100, strike: 100, years: 1, annualRate: 0.05, volatility: 0.2, steps: 3 });
    expect(tree.price).toBeCloseTo(11.04, 1);
    expect(tree.tree).toHaveLength(4);

    const risk = parametricVarCvar({ portfolioValue: 1000000, annualVolatility: 0.18, days: 10, confidence: 0.95 });
    expect(risk.varValue).toBeGreaterThan(50000);
    expect(risk.cvarValue).toBeGreaterThan(risk.varValue);

    const shock = durationShock({ price: 100, modifiedDuration: 6, convexity: 45, shockBps: 100 });
    expect(shock.pctChange).toBeLessThan(0);
    expect(shock.shockedPrice).toBeLessThan(100);
  });
});
