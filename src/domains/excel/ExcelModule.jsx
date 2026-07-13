import { useMemo, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Lightbulb, PlaySquare } from 'lucide-react';
import EmptyState from '../../components/EmptyState';
import FormulaBlock from '../../components/FormulaBlock';
import { excelModules } from '../../data/catalog';
import { excelContent } from '../../data/excelContent';
import { currency, dcfValue, weightedAverageCostOfCapital } from '../../lib/financeMath';
import { downloadCsv } from '../../lib/exportUtils';
import { useModuleProgress } from '../../hooks/useProgress';
import { recordSkillLabAttempt, saveResultArtifact } from '../../lib/learning';
import { Panel, Surface } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';

function ExerciseShell({ title, children, assumptions = {}, metrics = {}, csvRows }) {
  const [message, setMessage] = useState('');

  async function saveExerciseRep() {
    const topic = window.location.pathname.split('/').at(-1) || 'excel-drill';
    const sourceMeta = excelModules.find((module) => module.id === topic)?.sourceMeta || { level: 'level1', topicId: 'quant-methods' };
    const reviewTopic = sourceMeta.level === 'level1' ? sourceMeta.topicId : `${sourceMeta.level}:${sourceMeta.topicId}`;
    const artifact = await saveResultArtifact({
      type: 'excel-grid',
      domain: 'excel',
      level: sourceMeta.level,
      topic: reviewTopic,
      title,
      summary: `${title} completed as a CFA-mapped Excel drill.`,
      assumptions: { route: window.location.pathname, ...assumptions },
      metrics: { score: 100, ...metrics },
      path: window.location.pathname,
      objectiveIds: [`excel:${topic}:${sourceMeta.topicId}`],
    });
    await recordSkillLabAttempt({
      domain: 'excel',
      level: sourceMeta.level,
      topic: reviewTopic,
      labId: title,
      labType: 'excel-drill',
      objectiveIds: [`excel:${topic}:${sourceMeta.topicId}`],
      artifactId: artifact.id,
      score: 100,
      elapsedSeconds: 90,
    });
    setMessage('Exercise rep saved');
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
      icon={PlaySquare}
      tone="excel"
      status="excel"
      className="lab-panel"
      actions={
        <>
          <button className="btn btn-secondary btn-sm" onClick={exportCsv}>Export CSV</button>
          <button className="btn btn-secondary btn-sm" onClick={saveExerciseRep}>Save Drill Rep</button>
        </>
      }
    >
      {children}
      {message && <p className="muted-copy">{message}</p>}
    </Panel>
  );
}

function SpreadsheetGrid({ columns, rows, caption }) {
  return (
    <div className="spreadsheet-grid" role="table" aria-label={caption}>
      <div role="row" className="spreadsheet-row spreadsheet-head">
        {columns.map((column) => <div role="columnheader" key={column}>{column}</div>)}
      </div>
      {rows.map((row, rowIndex) => (
        <div role="row" className="spreadsheet-row" key={rowIndex}>
          {columns.map((column) => <div role="cell" key={column}>{row[column]}</div>)}
        </div>
      ))}
    </div>
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

function ReferenceBuilder() {
  const [columnLocked, setColumnLocked] = useState(true);
  const [rowLocked, setRowLocked] = useState(false);
  const reference = `${columnLocked ? '$' : ''}B${rowLocked ? '$' : ''}7`;

  return (
    <ExerciseShell
      title="Reference Builder"
      assumptions={{ columnLocked, rowLocked }}
      metrics={{ reference }}
      csvRows={[
        ['setting', 'value'],
        ['column_locked', columnLocked],
        ['row_locked', rowLocked],
        ['reference', reference],
      ]}
    >
      <div className="segmented-row">
        <button className={`btn ${columnLocked ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setColumnLocked((value) => !value)}>
          Column {columnLocked ? 'Locked' : 'Relative'}
        </button>
        <button className={`btn ${rowLocked ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRowLocked((value) => !value)}>
          Row {rowLocked ? 'Locked' : 'Relative'}
        </button>
      </div>
      <div className="calc-result">
        <div className="qv-fs-sm qv-text-muted">Resulting reference</div>
        <div className="calc-result-value">{reference}</div>
      </div>
    </ExerciseShell>
  );
}

function FormulaChooser() {
  const [scenario, setScenario] = useState('left-lookup');
  const recommendations = {
    'left-lookup': ['XLOOKUP', '=XLOOKUP(id, ids, values, "Missing")'],
    'two-way': ['INDEX/MATCH/MATCH', '=INDEX(table, MATCH(row_id, rows, 0), MATCH(header, headers, 0))'],
    'conditional-sum': ['SUMIFS', '=SUMIFS(amounts, region, "East", product, "Credit")'],
    'unique-list': ['UNIQUE + SORT', '=SORT(UNIQUE(customer_names))'],
  };
  const [name, formula] = recommendations[scenario];

  return (
    <ExerciseShell
      title="Formula Selector"
      assumptions={{ scenario }}
      metrics={{ recommendedFunction: name, formula }}
      csvRows={[
        ['scenario', 'function', 'formula'],
        [scenario, name, formula],
      ]}
    >
      <label className="calc-field">
        <span>Modeling Scenario</span>
        <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
          <option value="left-lookup">Return a value by ID</option>
          <option value="two-way">Retrieve from row and column labels</option>
          <option value="conditional-sum">Aggregate by multiple conditions</option>
          <option value="unique-list">Build a clean unique list</option>
        </select>
      </label>
      <div className="formula-answer">
        <strong>{name}</strong>
        <code>{formula}</code>
      </div>
    </ExerciseShell>
  );
}

function XnpvBuilder() {
  const [rate, setRate] = useState('10');
  const [initial, setInitial] = useState('-500');
  const [cashFlow, setCashFlow] = useState('160');
  const npv = useMemo(() => {
    const r = Number(rate) / 100;
    const first = Number(initial);
    const cf = Number(cashFlow);
    return first + [1, 2, 3, 4].reduce((sum, year) => sum + cf / Math.pow(1 + r, year), 0);
  }, [cashFlow, initial, rate]);
  const rows = [0, 1, 2, 3, 4].map((year) => ({
    Year: year,
    'Cash Flow': year === 0 ? Number(initial) : Number(cashFlow),
    'Discount Factor': year === 0 ? '1.0000' : (1 / Math.pow(1 + Number(rate) / 100, year)).toFixed(4),
  }));

  return (
    <ExerciseShell
      title="Finance Function Sanity Check"
      assumptions={{ rate, initial, cashFlow }}
      metrics={{ npv }}
      csvRows={[
        ['year', 'cash_flow', 'discount_factor'],
        ...rows.map((row) => [row.Year, row['Cash Flow'], row['Discount Factor']]),
        ['NPV', npv, ''],
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Discount Rate" value={rate} onChange={setRate} suffix="%" />
        <NumberField label="Initial Outflow" value={initial} onChange={setInitial} suffix="$" />
        <NumberField label="Annual Cash Flow" value={cashFlow} onChange={setCashFlow} suffix="$" />
      </div>
      <div className="calc-result">
        <div className="qv-fs-sm qv-text-muted">NPV with time-zero outflow handled separately</div>
        <div className="calc-result-value">{currency(npv)}</div>
      </div>
      <SpreadsheetGrid columns={['Year', 'Cash Flow', 'Discount Factor']} rows={rows} caption="NPV timing grid" />
    </ExerciseShell>
  );
}

function DcfSensitivity() {
  const [growth, setGrowth] = useState('8');
  const [margin, setMargin] = useState('18');
  const [waccInput, setWaccInput] = useState('9');
  const [terminalGrowth, setTerminalGrowth] = useState('2.5');
  const value = useMemo(() => {
    const revenue = 1000;
    const flows = Array.from({ length: 5 }, (_, index) => {
      const sales = revenue * Math.pow(1 + Number(growth) / 100, index + 1);
      return sales * (Number(margin) / 100) * 0.72;
    });
    return dcfValue({ cashFlows: flows, discountRate: Number(waccInput) / 100, terminalGrowth: Number(terminalGrowth) / 100 });
  }, [growth, margin, terminalGrowth, waccInput]);
  const scenarioRows = useMemo(() => {
    const waccCases = [Number(waccInput) - 1, Number(waccInput), Number(waccInput) + 1];
    const growthCases = [Number(terminalGrowth) - 0.5, Number(terminalGrowth), Number(terminalGrowth) + 0.5];
    return growthCases.flatMap((terminalCase) =>
      waccCases.map((waccCase) => {
        const revenue = 1000;
        const flows = Array.from({ length: 5 }, (_, index) => {
          const sales = revenue * Math.pow(1 + Number(growth) / 100, index + 1);
          return sales * (Number(margin) / 100) * 0.72;
        });
        const scenario = dcfValue({ cashFlows: flows, discountRate: waccCase / 100, terminalGrowth: terminalCase / 100 });
        return {
          WACC: `${waccCase.toFixed(1)}%`,
          'Terminal Growth': `${terminalCase.toFixed(1)}%`,
          'Enterprise Value': currency(scenario.enterpriseValue, 0),
        };
      }),
    );
  }, [growth, margin, terminalGrowth, waccInput]);

  return (
    <ExerciseShell
      title="DCF Sensitivity"
      assumptions={{ growth, margin, waccInput, terminalGrowth }}
      metrics={{ enterpriseValue: value.enterpriseValue, pvCashFlows: value.pvCashFlows, pvTerminalValue: value.pvTerminalValue }}
      csvRows={[
        ['wacc', 'terminal_growth', 'enterprise_value'],
        ...scenarioRows.map((row) => [row.WACC, row['Terminal Growth'], row['Enterprise Value']]),
      ]}
    >
      <div className="calc-grid">
        <NumberField label="Revenue Growth" value={growth} onChange={setGrowth} step="0.1" suffix="%" />
        <NumberField label="FCF Margin" value={margin} onChange={setMargin} step="0.1" suffix="%" />
        <NumberField label="WACC" value={waccInput} onChange={setWaccInput} step="0.1" suffix="%" />
        <NumberField label="Terminal Growth" value={terminalGrowth} onChange={setTerminalGrowth} step="0.1" suffix="%" />
      </div>
      <div className="metric-row">
        <div><small>PV Forecast FCF</small><strong>{currency(value.pvCashFlows)}</strong></div>
        <div><small>PV Terminal Value</small><strong>{currency(value.pvTerminalValue)}</strong></div>
        <div><small>Enterprise Value</small><strong>{currency(value.enterpriseValue)}</strong></div>
      </div>
      <SpreadsheetGrid columns={['WACC', 'Terminal Growth', 'Enterprise Value']} rows={scenarioRows} caption="DCF sensitivity grid" />
    </ExerciseShell>
  );
}

function MacroPlanner() {
  const [refresh, setRefresh] = useState(true);
  const [exportPdf, setExportPdf] = useState(true);
  const [clearOld, setClearOld] = useState(false);
  const steps = [
    'Option Explicit',
    refresh && 'Call RefreshModelInputs',
    clearOld && 'Call ClearPriorOutputs',
    'Call RunWorkbookChecks',
    exportPdf && 'Call ExportSummaryPdf',
    'Application.ScreenUpdating = True',
  ].filter(Boolean);

  return (
    <ExerciseShell
      title="Macro Safety Planner"
      assumptions={{ refresh, exportPdf, clearOld }}
      metrics={{ steps: steps.length }}
      csvRows={[
        ['step_number', 'macro_step'],
        ...steps.map((step, index) => [index + 1, step]),
      ]}
    >
      <div className="segmented-row">
        <button className={`btn ${refresh ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRefresh((value) => !value)}>Refresh Inputs</button>
        <button className={`btn ${exportPdf ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setExportPdf((value) => !value)}>Export PDF</button>
        <button className={`btn ${clearOld ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setClearOld((value) => !value)}>Clear Prior Output</button>
      </div>
      <pre className="code-panel">{steps.join('\n')}</pre>
    </ExerciseShell>
  );
}

function WaccMiniCard() {
  const wacc = weightedAverageCostOfCapital({
    equityWeight: 70,
    debtWeight: 30,
    costOfEquity: 0.11,
    costOfDebt: 0.055,
    taxRate: 0.24,
  });

  return (
    <Panel tone="excel" title="WACC Cross-Check">
      <p className="muted-copy">
        70% equity at 11%, 30% debt at 5.5%, 24% tax rate.
      </p>
      <div className="calc-result-value" style={{ fontSize: 'var(--fs-2xl)' }}>{(wacc * 100).toFixed(2)}%</div>
    </Panel>
  );
}

function ModuleExercise({ exercise }) {
  if (exercise === 'reference-builder') return <ReferenceBuilder />;
  if (exercise === 'formula-chooser') return <FormulaChooser />;
  if (exercise === 'xnpv-builder') return <XnpvBuilder />;
  if (exercise === 'dcf-sensitivity') return <DcfSensitivity />;
  if (exercise === 'macro-planner') return <MacroPlanner />;
  return null;
}

export default function ExcelModule() {
  const { module: modId } = useParams();
  const location = useLocation();
  const data = excelContent[modId];
  const sourceMeta = excelModules.find((module) => module.id === modId)?.sourceMeta || { level: 'level1', topicId: 'quant-methods' };
  const { completed, toggleComplete } = useModuleProgress({
    domain: 'excel',
    moduleId: data ? modId : null,
    title: data?.title || modId,
    path: location.pathname,
  });

  if (!data) {
    return (
      <div className="page-container">
        <EmptyState
          title="Excel module not found"
          description="That Excel training module is not in the current catalog."
          actionLabel="Back to Excel Training"
          actionTo="/excel"
        />
      </div>
    );
  }

  return (
    <div className="page-container">
      <Link to="/excel" className="back-link">
        <ArrowLeft size={16} /> Back to Excel Training
      </Link>

      <div className="module-header">
        <div>
          <div className="badge badge-green">Excel Practice</div>
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
            <Surface key={section.title} tone="excel" className="module-section-panel animate-fade" style={{ animationDelay: `${index * 80}ms` }}>
              <h2 style={{ marginTop: 0 }}>{section.title}</h2>
              <p>{section.content}</p>
              <div className="key-concept">
                <h4><Lightbulb size={16} /> Modeling Notes</h4>
                <ul className="qv-m-0" style={{ paddingLeft: 'var(--space-5)' }}>
                  {section.keyPoints.map((point) => <li key={point}>{point}</li>)}
                </ul>
              </div>
            </Surface>
          ))}
        </div>

        <aside className="learning-sidebar">
          <Panel tone="excel" title="Outcomes">
            <ul className="outcome-list">
              {data.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}
            </ul>
          </Panel>
          {data.formulas?.length ? (
            <Panel tone="excel" title="Formula Reference">
              {data.formulas.map((formula) => <FormulaBlock key={formula.name} {...formula} />)}
            </Panel>
          ) : null}
          {modId === 'dcf-modeling' && <WaccMiniCard />}
          <SourceRail
            compact
            limit={2}
            title="CFA Source Context"
            target={{
              kind: 'tool',
              domain: 'excel',
              level: sourceMeta.level,
              topicId: sourceMeta.topicId,
              title: data.title,
              keywords: [data.summary, ...data.outcomes, ...data.sections.map((section) => section.title)],
              route: location.pathname,
            }}
          />
        </aside>
      </div>

      <ModuleExercise exercise={data.exercise} />
    </div>
  );
}
