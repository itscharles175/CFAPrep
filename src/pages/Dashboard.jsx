import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GraduationCap, BrainCircuit, Table2, Calculator,
  Clock, Target, BookOpen, ChevronRight,
  Flame, Zap, Trophy, Download, Upload, Trash2, CalendarClock,
  Bookmark, StickyNote, ShieldAlert, Inbox, BadgeCheck, ClipboardList, BarChart3
} from 'lucide-react';
import { domains } from '../data/catalog';
import { useProgressSummary } from '../hooks/useProgress';
import { exportVaultData, importVaultData, previewVaultImport, resetVaultData } from '../lib/learning';
import { MetricTile, PageHeader, StatusBadge, Surface } from '../components/ui/Primitives';

const domainIcons = {
  cfa: GraduationCap,
  quant: BrainCircuit,
  excel: Table2,
};

const quickTools = [
  { title: 'Review Inbox', icon: Inbox, path: '/review', desc: 'Due work and weak areas' },
  { title: 'Analytics', icon: BarChart3, path: '/analytics', desc: 'Readiness and trends' },
  { title: 'Flashcards', icon: BadgeCheck, path: '/flashcards', desc: 'Formula and objective drills' },
  { title: 'Mock Exam', icon: ClipboardList, path: '/cfa/mock', desc: 'Mixed CFA section' },
  { title: 'TVM Calculator', icon: Calculator, path: '/calculators', desc: 'Time Value of Money' },
  { title: 'Formula Library', icon: BookOpen, path: '/formulas', desc: 'Searchable reference' },
  { title: 'Quick Quiz', icon: Target, path: '/cfa/level1/ethics/quiz', desc: 'Test your knowledge' },
];

function DomainCard({ domain, index }) {
  const Icon = domainIcons[domain.id] || BookOpen;
  const readableColor = domain.id === 'cfa' ? 'var(--exam)' : domain.id === 'quant' ? 'var(--quant)' : 'var(--excel)';

  return (
    <Link to={domain.path} className="glass-card animate-fade" style={{ animationDelay: `${index * 80}ms`, textDecoration: 'none', color: 'inherit' }}>
      <div className="flex-between" style={{ marginBottom: 'var(--space-5)' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 'var(--radius-md)',
          background: domain.gradient,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={26} color="white" />
        </div>
        <span className={`badge ${domain.color === '#D4A853' ? 'badge-gold' : domain.color === '#8B5CF6' ? 'badge-purple' : 'badge-green'}`}>
          {domain.badge}
        </span>
      </div>

      <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, marginBottom: 'var(--space-1)' }}>
        {domain.title}
      </h2>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--space-3)', fontWeight: 500 }}>
        {domain.subtitle}
      </p>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 'var(--space-5)' }}>
        {domain.description}
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-6)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
        {Object.entries(domain.stats).map(([key, val]) => (
          <div key={key}>
            <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: readableColor }}>{val}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{key}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: readableColor, fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
        Start Learning <ChevronRight size={16} />
      </div>
    </Link>
  );
}

function formatStudyTime(seconds) {
  if (!seconds) return '0m';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-export-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Dashboard() {
  const summary = useProgressSummary();
  const importRef = useRef(null);
  const [vaultMessage, setVaultMessage] = useState('');
  const [pendingImport, setPendingImport] = useState(null);
  const [pendingReset, setPendingReset] = useState(null);

  async function handleExport() {
    const payload = await exportVaultData();
    downloadJson(payload);
    setVaultMessage('Local vault exported as JSON.');
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const preview = previewVaultImport(payload);
      if (!preview.valid) {
        throw new Error(preview.errors.join(' '));
      }
      const totalRows = Object.values(preview.counts).reduce((sum, count) => sum + count, 0);
      setPendingImport({ payload, totalRows });
    } catch (error) {
      setVaultMessage(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      event.target.value = '';
    }
  }

  async function handleReset(scope) {
    const labels = {
      attempts: 'quiz attempts and review schedule',
      progress: 'module visits, completions, and quiz sessions',
      full: 'all local QuantVault data',
    };
    setPendingReset({ scope, label: labels[scope] });
  }

  async function confirmImport() {
    if (!pendingImport) return;
    await importVaultData(pendingImport.payload, 'merge');
    setVaultMessage(`Imported ${pendingImport.totalRows} progress, note, bookmark, and review rows.`);
    setPendingImport(null);
  }

  async function confirmReset() {
    if (!pendingReset) return;
    await resetVaultData(pendingReset.scope);
    setVaultMessage(`Reset ${pendingReset.label}.`);
    setPendingReset(null);
  }

  return (
    <div className="page-container">
      <PageHeader
        tone="study"
        badge="LOCAL STUDY COMMAND"
        title="QuantVault"
        subtitle="CFA, quantitative finance, and Excel practice organized around today’s next action, local vault safety, and exam readiness."
        meta={
          <>
            <StatusBadge tone="exam">Exam cockpit</StatusBadge>
            <StatusBadge tone="vault">Browser-local</StatusBadge>
          </>
        }
        actions={
          <>
            <button className="btn btn-secondary" onClick={handleExport}><Download size={16} /> Export</button>
            <button className="btn btn-primary" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
          </>
        }
      />

      <div className="cockpit-grid cockpit-grid-4" style={{ marginBottom: 'var(--space-8)' }}>
        <MetricTile label="Study Streak" value={`${summary.streakDays} day${summary.streakDays === 1 ? '' : 's'}`} detail="Current momentum" icon={Flame} tone="warning" />
        <MetricTile label="Questions" value={summary.questionsAnswered.toLocaleString()} detail="Answered locally" icon={Zap} tone="accent" />
        <MetricTile label="Study Time" value={formatStudyTime(summary.studyTimeSeconds)} detail="Recorded sessions" icon={Clock} tone="success" />
        <MetricTile label="Mastery" value={summary.masteryScore === null ? '-' : `${summary.masteryScore}%`} detail="Readiness snapshot" icon={Trophy} tone="exam" />
      </div>

      {(pendingImport || pendingReset) && (
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm local data action">
          <div className="glass-card no-hover confirm-dialog-card">
            <h2>{pendingImport ? 'Import Local Vault Data' : 'Reset Local Vault Data'}</h2>
            <p>
              {pendingImport
                ? `Import ${pendingImport.totalRows} rows into this browser profile? Existing QuantVault data will be merged.`
                : `Reset ${pendingReset.label} on this device? This changes only local browser data.`}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => { setPendingImport(null); setPendingReset(null); }}>Cancel</button>
              <button className="btn btn-primary" onClick={pendingImport ? confirmImport : confirmReset}>
                {pendingImport ? 'Import Data' : 'Reset Data'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Today */}
      <div style={{ marginBottom: 'var(--space-12)' }}>
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-end', marginBottom: 'var(--space-4)' }}>
          <div>
            <h2 className="section-title">Today</h2>
            <p className="section-subtitle">Adaptive local recommendations from your review queue and mastery snapshots</p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={handleExport}><Download size={16} /> Export</button>
            <button className="btn btn-secondary" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
            <input ref={importRef} type="file" accept="application/json,.json" onChange={handleImport} style={{ display: 'none' }} />
          </div>
        </div>

        {!summary.indexedDbAvailable && (
          <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-4)', borderColor: 'rgba(239,68,68,0.35)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
              <ShieldAlert size={20} color="var(--danger)" />
              <div>
                <div style={{ fontWeight: 700 }}>IndexedDB is unavailable</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
                  Local progress cannot be saved until browser storage is enabled.
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-6)', alignItems: 'stretch' }}>
          <Surface as={Link} to={summary.todayRecommendation.path} tone="study" status="exam" interactive className="animate-fade">
            <div className="badge badge-blue" style={{ marginBottom: 'var(--space-3)' }}>{summary.todayRecommendation.label}</div>
            <h3 style={{ fontSize: 'var(--fs-2xl)', margin: 0 }}>{summary.todayRecommendation.title}</h3>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{summary.todayRecommendation.reason}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--accent)', fontWeight: 700 }}>
              Start session <ChevronRight size={16} />
            </div>
          </Surface>

          <div className="glass-card no-hover">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', fontWeight: 700 }}>
              <CalendarClock size={18} color="var(--accent)" /> Due Reviews
            </div>
            {summary.dueReviews.length ? (
              summary.dueReviews.slice(0, 4).map((item) => (
                <Link key={item.id} to={item.path} style={{ display: 'block', color: 'inherit', textDecoration: 'none', padding: 'var(--space-3) 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600 }}>{item.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>Due {new Date(item.dueAt).toLocaleDateString()} · streak {item.correctStreak}</div>
                </Link>
              ))
            ) : (
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>No reviews are due. Take a quiz to seed the spaced-repetition queue.</p>
            )}
          </div>

          <div className="glass-card no-hover">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', fontWeight: 700 }}>
              <BrainCircuit size={18} color="var(--accent)" /> Weak Objectives
            </div>
            {summary.weakObjectives.length ? (
              summary.weakObjectives.slice(0, 4).map((item) => (
                <Link key={item.id} to={`/cfa/level1/${item.topic}/quiz?mode=weak-areas&objective=${item.learningObjective}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none', padding: 'var(--space-3) 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600 }}>{item.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>{item.score}% mastery · {item.attempts} attempts</div>
                </Link>
              ))
            ) : (
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>No weak objectives yet. Fresh quiz data will populate this panel.</p>
            )}
          </div>
        </div>

        <div className="glass-card no-hover" style={{ marginTop: 'var(--space-6)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <StickyNote size={16} color="var(--accent)" />
              <span style={{ fontSize: 'var(--fs-sm)' }}>{summary.notesCount} notes</span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Bookmark size={16} color="var(--accent)" />
              <span style={{ fontSize: 'var(--fs-sm)' }}>{summary.bookmarksCount} bookmarks</span>
            </div>
            {vaultMessage && <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{vaultMessage}</span>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => handleReset('attempts')}><Trash2 size={16} /> Attempts</button>
            <button className="btn btn-secondary" onClick={() => handleReset('progress')}><Trash2 size={16} /> Progress</button>
            <button className="btn btn-secondary" onClick={() => handleReset('full')}><Trash2 size={16} /> Full Reset</button>
          </div>
        </div>
      </div>

      {/* Domain Cards */}
      <div style={{ marginBottom: 'var(--space-12)' }}>
        <h2 className="section-title">Knowledge Domains</h2>
        <p className="section-subtitle">Choose a domain to begin your study journey</p>
        <div className="grid-3">
          {domains.map((d, i) => <DomainCard key={d.path} domain={d} index={i} />)}
        </div>
      </div>

      {/* Quick Tools */}
      <div>
        <h2 className="section-title">Quick Access</h2>
        <p className="section-subtitle">Jump into tools and practice</p>
        <div className="grid-3">
          {quickTools.map((tool, i) => (
            <Link key={tool.path} to={tool.path} className="glass-card animate-fade" style={{ animationDelay: `${i * 60}ms`, textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
              <div style={{ width: 44, height: 44, borderRadius: 'var(--radius-md)', background: 'rgba(59,130,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <tool.icon size={22} color="var(--accent)" />
              </div>
              <div>
                <div style={{ fontWeight: 600 }}>{tool.title}</div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{tool.desc}</div>
              </div>
              <ChevronRight size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            </Link>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-12)' }}>
        <h2 className="section-title">Learning Momentum</h2>
        <p className="section-subtitle">Your local progress is saved on this device</p>
        <div className="grid-3">
          <div className="glass-card no-hover">
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>MODULES COMPLETED</div>
            <div style={{ fontSize: 'var(--fs-3xl)', fontWeight: 800 }}>{summary.completedModules}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{summary.visitedModules} visited</div>
          </div>
          <div className="glass-card no-hover">
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>RECENT ACTIVITY</div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700 }}>{summary.lastActivity || 'No activity yet'}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Open a module or quiz to start the trail</div>
          </div>
          <div className="glass-card no-hover">
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>REVIEW QUEUE</div>
            <div style={{ fontSize: 'var(--fs-3xl)', fontWeight: 800 }}>{summary.upcomingReviews.length}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Weak areas from recent quizzes</div>
          </div>
        </div>
      </div>
    </div>
  );
}
