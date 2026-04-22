import { useCallback, useEffect, useReducer, useState } from "react";
import JobDetails from "./JobDetails";

const API = import.meta.env.VITE_API_URL || "";

// completable: true  -> worker has a handler, job will complete
// completable: false -> no handler, job will exhaust retries and land in DLQ
const PRESETS = [
  {
    label: "send_email",
    job_type: "send_email",
    payload: {
      to: "user@example.com",
      subject: "Hello",
      body: "This is a test email.",
    },
    priority: 5,
    completable: true,
  },
  {
    label: "resize_image",
    job_type: "resize_image",
    payload: { url: "https://example.com/photo.jpg", width: 800, height: 600 },
    priority: 6,
    completable: true,
  },
  {
    label: "export_4k_video",
    job_type: "export_4k_video",
    payload: {
      input: "s3://studio/raw_footage.mov",
      codec: "h265",
      bitrate_mbps: 80,
      output: "s3://studio/export_4k.mp4",
    },
    priority: 2,
    completable: true,
  },
  {
    label: "train_ml_model",
    job_type: "train_ml_model",
    payload: {
      model_name: "resnet50-finetune",
      dataset: "s3://datasets/imagenet-subset",
      epochs: 10,
    },
    priority: 4,
    completable: true,
  },
  {
    label: "index_search_corpus",
    job_type: "index_search_corpus",
    payload: {
      corpus_id: "wiki-2025-q1",
      document_count: 48200,
      language: "en",
    },
    priority: 6,
    completable: true,
  },
  {
    label: "flaky_once",
    job_type: "flaky_task",
    payload: {
      fail_count: 1,
      note: "Fails the first attempt, then completes on retry.",
    },
    priority: 5,
    completable: true,
  },
  {
    label: "flaky_twice",
    job_type: "flaky_task",
    payload: {
      fail_count: 2,
      note: "Fails twice, then completes on the third attempt.",
    },
    priority: 5,
    completable: true,
  },
  {
    label: "generate_report",
    job_type: "generate_report",
    payload: { report_id: "rpt_001", format: "pdf", date_range: "2025-Q1" },
    priority: 4,
    completable: false,
  },
  {
    label: "sync_crm",
    job_type: "sync_crm",
    payload: { account_id: "acct_42", provider: "salesforce" },
    priority: 7,
    completable: false,
  },
  {
    label: "transcode_video",
    job_type: "transcode_video",
    payload: {
      input: "s3://bucket/raw.mp4",
      output_format: "hls",
      quality: "1080p",
    },
    priority: 8,
    completable: false,
  },
  {
    label: "send_webhook",
    job_type: "send_webhook",
    payload: {
      url: "https://hooks.example.com/notify",
      event: "order.completed",
      order_id: "ord_9981",
    },
    priority: 3,
    completable: false,
  },
  {
    label: "migrate_database",
    job_type: "migrate_database",
    payload: {
      source: "postgres://prod-db/app",
      target: "postgres://new-db/app",
      tables: ["users", "orders", "events"],
    },
    priority: 1,
    completable: false,
  },
  {
    label: "deploy_infrastructure",
    job_type: "deploy_infrastructure",
    payload: {
      stack: "prod-us-east-1",
      provider: "aws",
      services: ["eks", "rds", "elasticache"],
    },
    priority: 2,
    completable: false,
  },
];

interface JobSpec {
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
}

const LOAD_SCENARIOS: {
  label: string;
  description: string;
  outcome: "complete" | "dead" | "mixed";
  jobs: JobSpec[];
}[] = [
  {
    label: "Happy Path",
    description: "10 jobs — all complete",
    outcome: "complete",
    jobs: Array.from({ length: 10 }, (_, i) => ({
      job_type: i % 2 === 0 ? "send_email" : "resize_image",
      payload: { batch: "happy-path", index: i, to: `user${i}@example.com` },
      priority: (i % 5) + 3,
    })),
  },
  {
    label: "Flaky Once",
    description: "8 jobs — each fails once, then succeeds",
    outcome: "complete",
    jobs: Array.from({ length: 8 }, (_, i) => ({
      job_type: "flaky_task",
      payload: { batch: "flaky-once", index: i, fail_count: 1 },
      priority: (i % 4) + 4,
    })),
  },
  {
    label: "Flaky Twice",
    description: "8 jobs — each fails twice, then succeeds",
    outcome: "complete",
    jobs: Array.from({ length: 8 }, (_, i) => ({
      job_type: "flaky_task",
      payload: { batch: "flaky-twice", index: i, fail_count: 2 },
      priority: (i % 4) + 4,
    })),
  },
  {
    label: "Flaky Intensive",
    description: "16 jobs — flaky retries mixed with long-running work",
    outcome: "mixed",
    jobs: Array.from({ length: 16 }, (_, i) => {
      const intensiveTypes = [
        "export_4k_video",
        "train_ml_model",
        "index_search_corpus",
      ];
      const failCount = i % 2 === 0 ? 1 : 2;
      return {
        job_type:
          i % 2 === 0
            ? "flaky_task"
            : intensiveTypes[i % intensiveTypes.length],
        payload:
          i % 2 === 0
            ? { batch: "flaky-intensive", index: i, fail_count: failCount }
            : { batch: "flaky-intensive", index: i, phase: "intensive" },
        priority: ((i * 2 + 3) % 10) + 1,
      };
    }),
  },
  {
    label: "Priority Storm",
    description: "10 high-priority — all complete",
    outcome: "complete",
    jobs: Array.from({ length: 10 }, (_, i) => ({
      job_type: "send_email",
      payload: {
        batch: "priority-storm",
        index: i,
        to: `vip${i}@example.com`,
        subject: `Urgent ${i}`,
      },
      priority: (i % 3) + 1,
    })),
  },
  {
    label: "DLQ Demo",
    description: "12 jobs — all go dead",
    outcome: "dead",
    jobs: Array.from({ length: 12 }, (_, i) => {
      const types = [
        "generate_report",
        "sync_crm",
        "transcode_video",
        "send_webhook",
        "migrate_database",
        "deploy_infrastructure",
      ];
      return {
        job_type: types[i % types.length],
        payload: { batch: "dlq-demo", index: i },
        priority: (i % 6) + 3,
      };
    }),
  },
  {
    label: "Mixed Reality",
    description: "20 jobs — ~half complete, ~half dead",
    outcome: "mixed",
    jobs: Array.from({ length: 20 }, (_, i) => {
      const completable = [
        "send_email",
        "resize_image",
        "export_4k_video",
        "train_ml_model",
        "index_search_corpus",
      ];
      const unhandled = [
        "generate_report",
        "sync_crm",
        "transcode_video",
        "send_webhook",
        "migrate_database",
        "deploy_infrastructure",
      ];
      return {
        job_type:
          i % 2 === 0
            ? completable[i % completable.length]
            : unhandled[i % unhandled.length],
        payload: { batch: "mixed-reality", index: i },
        priority: (i % 10) + 1,
      };
    }),
  },
  {
    label: "Worker Stress",
    description: "30 jobs — all complete",
    outcome: "complete",
    jobs: Array.from({ length: 30 }, (_, i) => {
      const types = [
        "send_email",
        "resize_image",
        "export_4k_video",
        "train_ml_model",
        "index_search_corpus",
      ];
      return {
        job_type: types[i % types.length],
        payload: { batch: "worker-stress", index: i },
        priority: ((i * 3 + 1) % 10) + 1,
      };
    }),
  },
  {
    label: "Intensive",
    description: "15 heavy jobs — all complete, workers stay busy",
    outcome: "complete",
    jobs: Array.from({ length: 15 }, (_, i) => {
      const types = [
        "export_4k_video",
        "train_ml_model",
        "index_search_corpus",
      ];
      return {
        job_type: types[i % types.length],
        payload: { batch: "intensive", index: i },
        priority: ((i * 7 + 2) % 10) + 1,
      };
    }),
  },
];

interface QueueStats {
  queues: { high: number; normal: number; low: number };
  jobs: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    dead: number;
  };
  workers_alive: number;
}

interface DeadJob {
  id: string;
  job_type: string;
  priority: number;
  error_msg: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string | null;
}

interface BrowseJob {
  id: string;
  job_type: string;
  status: string;
  priority: number;
  retry_count: number;
  max_retries: number;
  created_at: string | null;
  error_msg: string | null;
}

interface Worker {
  worker_id: string;
  current_job?: {
    id: string;
    job_type: string;
    status: string;
  } | null;
}

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; jobId: string }
  | { status: "error"; message: string };

type SubmitAction =
  | { type: "start" }
  | { type: "success"; jobId: string }
  | { type: "error"; message: string }
  | { type: "reset" };

function submitReducer(_: SubmitState, action: SubmitAction): SubmitState {
  switch (action.type) {
    case "start":
      return { status: "submitting" };
    case "success":
      return { status: "success", jobId: action.jobId };
    case "error":
      return { status: "error", message: action.message };
    case "reset":
      return { status: "idle" };
  }
}

const FORM_DEFAULT = { jobType: "", payload: "{}", priority: 5 };

function formatCount(value: number | null | undefined) {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function priorityTone(priority: number) {
  return priority <= 3 ? "red" : priority <= 6 ? "yellow" : "blue";
}

function priorityLabel(priority: number) {
  return priority <= 3 ? "HIGH" : priority <= 6 ? "NORMAL" : "LOW";
}

function compactId(value: string) {
  return value.slice(0, 8);
}

function App() {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [deadJobs, setDeadJobs] = useState<DeadJob[]>([]);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [activeStreamsModalOpen, setActiveStreamsModalOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [jobForm, setJobForm] = useState(FORM_DEFAULT);
  const [submitState, dispatch] = useReducer(submitReducer, { status: "idle" });
  const [loadState, setLoadState] = useState<{
    running: boolean;
    progress: { done: number; total: number } | null;
  }>({ running: false, progress: null });
  const [scenarioJobIds, setScenarioJobIds] = useState<string[]>([]);

  // Browse jobs state
  const [browseStatus, setBrowseStatus] = useState<string>("pending");
  const [browseLimit, setBrowseLimit] = useState(20);
  const [browseJobs, setBrowseJobs] = useState<BrowseJob[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/queue/stats`);
      if (res.ok) {
        setStats(await res.json());
      }
    } catch {
      // Network failures are expected during restart cycles.
    }
  }, []);

  const fetchDeadJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/jobs?status=dead&limit=20`);
      if (res.ok) {
        setDeadJobs(await res.json());
      }
    } catch {
      // Ignore transient fetch errors.
    }
  }, []);

  const fetchBrowseJobs = useCallback(async () => {
    try {
      const res = await fetch(
        `${API}/api/jobs?status=${browseStatus}&limit=${browseLimit}`,
      );
      if (res.ok) {
        setBrowseJobs(await res.json());
      }
    } catch {
      // Ignore transient fetch errors.
    }
  }, [browseStatus, browseLimit]);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/workers`);
      if (res.ok) {
        const data = await res.json();
        setWorkers(data.workers || []);
      }
    } catch {
      // Ignore transient fetch errors.
    }
  }, []);

  const retryJob = async (jobId: string) => {
    try {
      const res = await fetch(`${API}/api/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        // Refresh the browse jobs and stats
        fetchStats();
        fetchBrowseJobs();
        setSelectedJobIds((prev) =>
          prev.includes(jobId) ? prev : [...prev, jobId],
        );
      }
    } catch {
      // Ignore errors
    }
  };

  useEffect(() => {
    fetchStats();
    fetchDeadJobs();
    fetchBrowseJobs();
    fetchWorkers();

    const id = setInterval(() => {
      fetchStats();
      fetchDeadJobs();
      fetchBrowseJobs();
      fetchWorkers();
    }, 5000);

    return () => clearInterval(id);
  }, [fetchStats, fetchDeadJobs, fetchBrowseJobs, fetchWorkers]);

  const submitJob = async (event: { preventDefault(): void }) => {
    event.preventDefault();

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(jobForm.payload);
    } catch {
      dispatch({ type: "error", message: "Payload must be valid JSON" });
      return;
    }

    dispatch({ type: "start" });

    try {
      const res = await fetch(`${API}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_type: jobForm.jobType,
          payload,
          priority: jobForm.priority,
        }),
      });

      if (!res.ok) {
        dispatch({
          type: "error",
          message: `Error ${res.status}: ${res.statusText}`,
        });
        return;
      }

      const job = await res.json();
      dispatch({ type: "success", jobId: job.id });
      setSelectedJobIds((previous) =>
        previous.includes(job.id) ? previous : [...previous, job.id],
      );
      setActiveStreamsModalOpen(true);
      setJobForm(FORM_DEFAULT);
      fetchStats();
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const runLoad = async (jobs: JobSpec[]) => {
    setLoadState({ running: true, progress: { done: 0, total: jobs.length } });
    setScenarioJobIds([]);

    let done = 0;
    const ids = await Promise.all(
      jobs.map(async (job) => {
        try {
          const res = await fetch(`${API}/api/jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job),
          });

          if (!res.ok) {
            return null;
          }

          const data = await res.json();
          return data.id as string;
        } catch {
          return null;
        } finally {
          done += 1;
          setLoadState((previous) => ({
            ...previous,
            progress: { done, total: jobs.length },
          }));
        }
      }),
    );

    setScenarioJobIds(ids.filter((id): id is string => Boolean(id)));
    setLoadState({ running: false, progress: null });
    fetchStats();
  };

  const queueStats = stats?.queues ?? { high: 0, normal: 0, low: 0 };
  const jobStats = stats?.jobs ?? {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    dead: 0,
  };
  const queuedTotal = queueStats.high + queueStats.normal + queueStats.low;
  const totalObserved =
    jobStats.pending +
    jobStats.processing +
    jobStats.completed +
    jobStats.failed +
    jobStats.dead;
  const activeStreams = selectedJobIds.length;
  const overflowStreamCount = Math.max(activeStreams - 2, 0);
  const normalizedQuery = findQuery.trim().toLowerCase();
  const matchesQuery = useCallback(
    (...values: Array<string | number | null | undefined>) => {
      if (!normalizedQuery) {
        return true;
      }

      return values.some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(normalizedQuery),
      );
    },
    [normalizedQuery],
  );

  const filteredStreamIds = selectedJobIds.filter((id) => matchesQuery(id));
  const filteredDeadJobs = deadJobs
    .filter((job) => matchesQuery(job.id, job.job_type))
    .slice(0, 6);
  const streamMatches = filteredStreamIds.length;
  const deadMatches = deadJobs.filter((job) =>
    matchesQuery(job.id, job.job_type),
  ).length;
  const completionRate =
    totalObserved > 0
      ? Math.round((jobStats.completed / totalObserved) * 100)
      : 0;
  const deadRate =
    totalObserved > 0 ? Math.round((jobStats.dead / totalObserved) * 100) : 0;

  const jumpToSection = (id: string) => {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="dashboard-shell">
      <header className="hero panel">
        <div className="hero-copy">
          <p className="eyebrow">Queue observability workspace</p>
          <h1>NeoQueue</h1>
          <p className="hero-description">
            Track queue pressure, inspect dead-letter pressure, and drill into
            live job traces from one screen.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="hero-metric">
            <span className="hero-metric-label">workers alive</span>
            <strong>{formatCount(stats?.workers_alive ?? 0)}</strong>
            <span
              className={`hero-indicator ${stats && stats.workers_alive > 0 ? "alive" : "dead"}`}
            />
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">queued now</span>
            <strong>{formatCount(queuedTotal)}</strong>
            <span className="hero-metric-subtext">
              high / normal / low combined
            </span>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">live streams</span>
            <strong>{formatCount(activeStreams)}</strong>
            <span className="hero-metric-subtext">open job traces</span>
          </div>
        </div>
      </header>

      <section className="workspace-nav panel">
        <div className="workspace-nav-row">
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("active-streams")}
          >
            Active streams
          </button>
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("job-browser")}
          >
            Jobs
          </button>
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("workers-panel")}
          >
            Workers
          </button>
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("dead-jobs")}
          >
            Dead jobs
          </button>
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("submit-work")}
          >
            Submit
          </button>
          <button
            type="button"
            className="nav-chip"
            onClick={() => jumpToSection("load-testing")}
          >
            Scenarios
          </button>
        </div>
        <div className="workspace-search">
          <input
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            placeholder="Find job id, type, or status"
            aria-label="Find job id, type, or status"
          />
          {findQuery && (
            <button
              type="button"
              className="link-btn"
              onClick={() => setFindQuery("")}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="summary-grid">
        <article className="metric-card panel">
          <span className="metric-label">Queue pressure</span>
          <strong>{formatCount(queuedTotal)}</strong>
          <span className="metric-note">
            High {formatCount(queueStats.high)} · Normal{" "}
            {formatCount(queueStats.normal)} · Low {formatCount(queueStats.low)}
          </span>
        </article>
        <article className="metric-card panel">
          <span className="metric-label">Processing</span>
          <strong>{formatCount(jobStats.processing)}</strong>
          <span className="metric-note">
            Pending {formatCount(jobStats.pending)} · Active workers stay on
            these jobs
          </span>
        </article>
        <article className="metric-card panel">
          <span className="metric-label">Completion rate</span>
          <strong>{completionRate}%</strong>
          <span className="metric-note">
            Completed {formatCount(jobStats.completed)} of{" "}
            {formatCount(totalObserved)}
          </span>
        </article>
        <article className="metric-card panel">
          <span className="metric-label">Dead-letter rate</span>
          <strong>{deadRate}%</strong>
          <span className="metric-note">
            Dead {formatCount(jobStats.dead)} · Failed{" "}
            {formatCount(jobStats.failed)}
          </span>
        </article>
      </section>

      <div className="workspace-grid">
        <main className="analysis-column">
          <section className="panel section-card" id="active-streams">
            <div className="section-header">
              <div>
                <p className="eyebrow">Live analysis</p>
                <h2>Active streams</h2>
              </div>
              <div className="section-actions">
                <span className="section-meta">
                  {normalizedQuery
                    ? `${streamMatches}/${activeStreams} shown`
                    : `${activeStreams} open`}
                </span>
                {activeStreams > 0 && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setActiveStreamsModalOpen(true)}
                  >
                    See all
                  </button>
                )}
              </div>
            </div>

            {activeStreams === 0 ? (
              <div className="empty-state">
                <p>No live traces selected yet.</p>
                <span>
                  Submit a job, click a scenario job, or open a dead-letter row
                  to start a stream.
                </span>
              </div>
            ) : (
              <div className="stream-grid">
                {filteredStreamIds.length === 0 ? (
                  <div className="empty-state">
                    <p>No matching active streams.</p>
                    <span>Clear the search to see the open traces again.</span>
                  </div>
                ) : (
                  <>
                    {filteredStreamIds.slice(0, 2).map((id) => (
                      <article className="stream-card panel" key={id}>
                        <div className="stream-card-header">
                          <div>
                            <p className="stream-label">job stream</p>
                            <h3>{compactId(id)}</h3>
                          </div>
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() =>
                              setSelectedJobIds((previous) =>
                                previous.filter((value) => value !== id),
                              )
                            }
                          >
                            Close
                          </button>
                        </div>
                        <JobDetails jobId={id} apiBase={API} compact />
                      </article>
                    ))}
                    {overflowStreamCount > 0 && !normalizedQuery && (
                      <button
                        type="button"
                        className="stream-overflow-card panel"
                        onClick={() => setActiveStreamsModalOpen(true)}
                      >
                        <span className="stream-overflow-count">
                          +{overflowStreamCount}
                        </span>
                        <strong>Open the compact view</strong>
                        <span className="scenario-description">
                          See every active stream without extending the page.
                        </span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <section className="panel section-card" id="job-browser">
            <div className="section-header">
              <div>
                <p className="eyebrow">Job management</p>
                <h2>Browse jobs</h2>
              </div>
              <span className="section-meta">{browseJobs.length} shown</span>
            </div>

            <div className="job-browser-controls">
              <div className="control-group">
                <label htmlFor="status-filter">Status:</label>
                <select
                  id="status-filter"
                  value={browseStatus}
                  onChange={(e) => setBrowseStatus(e.target.value)}
                >
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="dead">Dead</option>
                </select>
              </div>
              <div className="control-group">
                <label htmlFor="limit-filter">Limit:</label>
                <select
                  id="limit-filter"
                  value={browseLimit}
                  onChange={(e) => setBrowseLimit(Number(e.target.value))}
                >
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </div>
            </div>

            {browseJobs.length === 0 ? (
              <div className="empty-state">
                <p>No jobs in {browseStatus} status.</p>
              </div>
            ) : (
              <div className="browse-list">
                {browseJobs.map((job) => (
                  <div key={job.id} className="browse-item panel">
                    <div className="browse-item-header">
                      <div>
                        <span className="browse-type">{job.job_type}</span>
                        <span className="browse-id">{compactId(job.id)}</span>
                      </div>
                      <span className={`badge ${priorityTone(job.priority)}`}>
                        {priorityLabel(job.priority)}
                      </span>
                    </div>
                    <div className="browse-meta">
                      <span
                        className={`status-badge ${job.status === "completed" ? "green" : job.status === "processing" ? "blue" : "yellow"}`}
                      >
                        {job.status}
                      </span>
                      <span className="browse-retries">
                        {job.retry_count}/{job.max_retries}
                      </span>
                      {job.created_at && (
                        <span className="browse-date">
                          {new Date(job.created_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="browse-actions">
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          setSelectedJobIds((prev) =>
                            prev.includes(job.id)
                              ? prev.filter((id) => id !== job.id)
                              : [...prev, job.id],
                          )
                        }
                      >
                        Watch
                      </button>
                      {(job.status === "failed" ||
                        job.status === "dead") && (
                        <button
                          type="button"
                          className="link-btn retry-btn"
                          onClick={() => retryJob(job.id)}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel section-card" id="workers-panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">System status</p>
                <h2>Live workers</h2>
              </div>
              <span className="section-meta">
                {workers.length} worker{workers.length !== 1 ? "s" : ""}
              </span>
            </div>

            {workers.length === 0 ? (
              <div className="empty-state">
                <p>No workers alive.</p>
                <span>Start worker processes to see them here.</span>
              </div>
            ) : (
              <div className="workers-list">
                {workers.map((worker) => (
                  <div key={worker.worker_id} className="worker-card panel">
                    <div className="worker-header">
                      <strong className="worker-id">{worker.worker_id}</strong>
                      <span className="worker-status alive">●</span>
                    </div>
                    {worker.current_job ? (
                      <div className="worker-job">
                        <div className="worker-job-type">
                          {worker.current_job.job_type}
                        </div>
                        <div className="worker-job-meta">
                          <span>{compactId(worker.current_job.id)}</span>
                          <span
                            className={`badge ${worker.current_job.status === "completed" ? "green" : worker.current_job.status === "processing" ? "blue" : "yellow"}`}
                          >
                            {worker.current_job.status}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="worker-idle">Idle</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel section-card" id="dead-jobs">
            <div className="section-header">
              <div>
                <p className="eyebrow">Failure analysis</p>
                <h2>Dead letter queue</h2>
              </div>
              <span className="section-meta">
                {normalizedQuery
                  ? `${deadMatches}/${deadJobs.length} matched`
                  : `${formatCount(deadJobs.length)} records`}
              </span>
            </div>

            {filteredDeadJobs.length === 0 ? (
              <div className="empty-state">
                <p>No dead jobs right now.</p>
                <span>
                  The queue is clear. Use the scenarios on the right to force
                  retry and DLQ behavior.
                </span>
              </div>
            ) : (
              <div className="dead-list">
                {filteredDeadJobs.map((job) => (
                  <button
                    key={job.id}
                    className="dead-item"
                    type="button"
                    onClick={() =>
                      setSelectedJobIds((previous) =>
                        previous.includes(job.id)
                          ? previous.filter((value) => value !== job.id)
                          : [...previous, job.id],
                      )
                    }
                    title="Toggle live stream"
                  >
                    <div className="dead-item-header">
                      <div>
                        <span className="dead-type">{job.job_type}</span>
                        <span className="dead-id">{job.id}</span>
                      </div>
                      <span className="dead-retries">
                        {job.retry_count}/{job.max_retries} retries
                      </span>
                    </div>
                    <div className="dead-meta">
                      <span className={`badge ${priorityTone(job.priority)}`}>
                        p{job.priority} · {priorityLabel(job.priority)}
                      </span>
                      {job.created_at && (
                        <span className="dead-created">
                          {new Date(job.created_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {job.error_msg && (
                      <div className="dead-error">{job.error_msg}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="control-column">
          <div className="control-stack">
            <section className="panel section-card" id="submit-work">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Submit work</p>
                  <h2>Enqueue job</h2>
                </div>
                <span className="section-meta">manual</span>
              </div>

              <div className="preset-grid">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="preset-card"
                    onClick={() => {
                      setJobForm({
                        jobType: preset.job_type,
                        payload: JSON.stringify(preset.payload, null, 2),
                        priority: preset.priority,
                      });
                      dispatch({ type: "reset" });
                    }}
                  >
                    <span
                      className={`preset-dot ${preset.completable ? "complete" : "dead"}`}
                    />
                    <span>
                      <strong>{preset.label}</strong>
                      <small>
                        {preset.completable ? "will complete" : "will hit DLQ"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>

              <form onSubmit={submitJob} className="job-form">
                <label htmlFor="job-type">Job type</label>
                <input
                  id="job-type"
                  value={jobForm.jobType}
                  onChange={(event) =>
                    setJobForm((previous) => ({
                      ...previous,
                      jobType: event.target.value,
                    }))
                  }
                  placeholder="send_email"
                  required
                />

                <label htmlFor="job-payload">Payload JSON</label>
                <textarea
                  id="job-payload"
                  value={jobForm.payload}
                  onChange={(event) =>
                    setJobForm((previous) => ({
                      ...previous,
                      payload: event.target.value,
                    }))
                  }
                  rows={5}
                  spellCheck={false}
                />

                <label htmlFor="job-priority">Priority 1 to 10</label>
                <input
                  id="job-priority"
                  type="number"
                  min={1}
                  max={10}
                  value={jobForm.priority}
                  onChange={(event) =>
                    setJobForm((previous) => ({
                      ...previous,
                      priority: Number(event.target.value),
                    }))
                  }
                />

                {submitState.status === "error" && (
                  <div className="form-error">{submitState.message}</div>
                )}

                <button
                  type="submit"
                  disabled={submitState.status === "submitting"}
                >
                  {submitState.status === "submitting"
                    ? "Enqueueing…"
                    : "Enqueue job"}
                </button>
              </form>

              {submitState.status === "success" && (
                <p className="submitted-id">
                  Submitted{" "}
                  <button
                    className="link-btn"
                    type="button"
                    onClick={() =>
                      setSelectedJobIds((previous) =>
                        previous.includes(submitState.jobId)
                          ? previous
                          : [...previous, submitState.jobId],
                      )
                    }
                  >
                    {submitState.jobId}
                  </button>
                </p>
              )}
            </section>

            <section className="panel section-card" id="load-testing">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Load testing</p>
                  <h2>Scenario runner</h2>
                </div>
                <span className="section-meta">
                  {loadState.running ? "running" : "ready"}
                </span>
              </div>

              <div className="scenario-grid">
                {LOAD_SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.label}
                    className="scenario-card"
                    type="button"
                    disabled={loadState.running}
                    onClick={() => runLoad(scenario.jobs)}
                  >
                    <div className="scenario-card-top">
                      <span className={`scenario-outcome ${scenario.outcome}`}>
                        {scenario.outcome === "complete"
                          ? "complete"
                          : scenario.outcome === "dead"
                            ? "dead"
                            : "mixed"}
                      </span>
                      <strong>{scenario.label}</strong>
                    </div>
                    <span className="scenario-description">
                      {scenario.description}
                    </span>
                  </button>
                ))}
              </div>

              {loadState.progress && (
                <div className="load-progress">
                  <div
                    className="load-bar"
                    style={{
                      width: `${(loadState.progress.done / loadState.progress.total) * 100}%`,
                    }}
                  />
                  <span className="load-progress-text">
                    {loadState.progress.done}/{loadState.progress.total}{" "}
                    enqueued
                  </span>
                </div>
              )}

              {scenarioJobIds.length > 0 && (
                <div className="scenario-jobs">
                  <div className="section-subheader">
                    <span>Captured job ids</span>
                    <span>{scenarioJobIds.length}</span>
                  </div>
                  <div className="scenario-actions">
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        setSelectedJobIds((previous) => {
                          const next = [...previous];
                          for (const id of scenarioJobIds) {
                            if (!next.includes(id)) {
                              next.push(id);
                            }
                          }
                          return next;
                        })
                      }
                    >
                      Add all
                    </button>
                  </div>
                  <div className="scenario-jobs-list">
                    {scenarioJobIds.map((id) => (
                      <button
                        key={id}
                        className={`scenario-job-chip ${selectedJobIds.includes(id) ? "active" : ""}`}
                        type="button"
                        onClick={() =>
                          setSelectedJobIds((previous) =>
                            previous.includes(id)
                              ? previous.filter((value) => value !== id)
                              : [...previous, id],
                          )
                        }
                      >
                        {compactId(id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </aside>
      </div>

      {activeStreamsModalOpen && activeStreams > 0 && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setActiveStreamsModalOpen(false)}
        >
          <div
            className="modal-shell panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="active-streams-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Live analysis</p>
                <h2 id="active-streams-modal-title">All active streams</h2>
              </div>
              <div className="modal-header-actions">
                <span className="section-meta">
                  {normalizedQuery
                    ? `${streamMatches}/${activeStreams} matched`
                    : `${activeStreams} open`}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setSelectedJobIds([])}
                >
                  Clear all
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setActiveStreamsModalOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="modal-stream-grid">
              {filteredStreamIds.length === 0 ? (
                <div className="empty-state">
                  <p>No matching active streams.</p>
                  <span>Use the search bar to narrow the live traces.</span>
                </div>
              ) : (
                filteredStreamIds.map((id) => (
                  <article
                    className="stream-card panel compact-stream-card"
                    key={id}
                  >
                    <div className="stream-card-header">
                      <div>
                        <p className="stream-label">job stream</p>
                        <h3>{compactId(id)}</h3>
                      </div>
                    </div>
                    <JobDetails jobId={id} apiBase={API} compact />
                    <div className="stream-card-actions">
                      <button
                        className="link-btn"
                        type="button"
                        onClick={() =>
                          setSelectedJobIds((previous) =>
                            previous.filter((value) => value !== id),
                          )
                        }
                      >
                        Remove stream
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
