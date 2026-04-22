import { useState, useEffect, useMemo } from "react";

interface JobEvent {
  job_id: string;
  status: string;
  priority: number;
  retry_count: number;
  max_retries: number;
  worker_id: string | null;
  error_msg: string | null;
  payload: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  pending: "yellow",
  processing: "blue",
  completed: "green",
  failed: "orange",
  dead: "red",
  retrying: "yellow",
};

const PRIORITY_LABEL = (p: number) =>
  p <= 3 ? "HIGH" : p <= 6 ? "NORMAL" : "LOW";

const PRIORITY_CLASS = (p: number) =>
  p <= 3 ? "red" : p <= 6 ? "yellow" : "blue";

const TERMINAL = new Set(["completed", "dead"]);

function buildTimeline(events: JobEvent[]): JobEvent[] {
  return events.flatMap((event, index) => {
    const previous = events[index - 1] ?? null;
    const retriedAfterMissedFailure =
      previous !== null &&
      event.retry_count > previous.retry_count &&
      previous.status !== "failed";

    if (retriedAfterMissedFailure) {
      return [
        { ...event, status: "retrying", started_at: null, completed_at: null },
        event,
      ];
    }
    return [event];
  });
}

interface Props {
  jobId: string;
  apiBase: string;
  compact?: boolean;
}

export default function JobDetails({ jobId, apiBase, compact = false }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setEvents([]);
    setDone(false);
    setConnected(true);

    const sse = new EventSource(`${apiBase}/api/jobs/${jobId}/stream`);

    sse.onmessage = (e: MessageEvent) => {
      const event: JobEvent = JSON.parse(e.data as string);
      setEvents((prev) => [...prev, event]);
      if (TERMINAL.has(event.status)) {
        setDone(true);
        setConnected(false);
        sse.close();
      }
    };

    sse.onerror = () => {
      setConnected(false);
      sse.close();
    };

    return () => {
      sse.close();
      setConnected(false);
    };
  }, [jobId, apiBase]);

  const first = events[0] ?? null;
  const latest = events[events.length - 1] ?? null;
  const activeStatus = latest?.status ?? "waiting";
  const startedAt = events.find((e) => e.started_at)?.started_at ?? null;
  const completedAt = events.findLast((e) => e.completed_at)?.completed_at ?? null;
  const totalElapsed = startedAt
    ? (
        ((completedAt ? new Date(completedAt).getTime() : Date.now()) -
          new Date(startedAt).getTime()) /
        1000
      ).toFixed(2)
    : null;
  const timeline = useMemo(() => buildTimeline(events), [events]);

  return (
    <div className="job-details">
      <div className="job-id-row">
        <div className="job-title-group">
          <span
            className={`status-chip ${STATUS_CLASS[activeStatus] ?? "yellow"}`}
          >
            {activeStatus}
          </span>
          <span className="mono job-id-text">{jobId}</span>
        </div>
        <span
          className={`connection-badge ${connected ? "connected" : "disconnected"}`}
        >
          {connected ? "streaming" : done ? "finished" : "closed"}
        </span>
      </div>

      <div className="job-meta-grid">
        <div className="job-meta-item">
          <span className="job-meta-label">priority</span>
          <span
            className={`badge ${PRIORITY_CLASS(first?.priority ?? latest?.priority ?? 5)}`}
          >
            {first?.priority ?? latest?.priority ?? 5} ·{" "}
            {PRIORITY_LABEL(first?.priority ?? latest?.priority ?? 5)}
          </span>
        </div>
        <div className="job-meta-item">
          <span className="job-meta-label">retries</span>
          <strong>
            {latest ? `${latest.retry_count}/${latest.max_retries}` : "—"}
          </strong>
        </div>
        <div className="job-meta-item">
          <span className="job-meta-label">worker</span>
          <strong className="mono">{latest?.worker_id ?? "—"}</strong>
        </div>
        <div className="job-meta-item">
          <span className="job-meta-label">full elapsed time</span>
          <strong>{totalElapsed ? `${totalElapsed}s` : "—"}</strong>
        </div>
      </div>

      {!compact && first?.payload && (
        <details className="payload-details" open={events.length <= 2}>
          <summary>
            payload
            <span className="payload-summary-note">structured data</span>
          </summary>
          <pre className="payload-pre">
            {JSON.stringify(first.payload, null, 2)}
          </pre>
        </details>
      )}

      <div className={`events-list ${compact ? "compact" : ""}`}>
        {events.length === 0 && (
          <span className="empty">Waiting for events…</span>
        )}
        {timeline.slice(compact ? -4 : 0).map((ev, i) => {
          const cls = STATUS_CLASS[ev.status] ?? "";
          return (
            <div key={i} className={`event-row ${cls}`}>
              <div className="event-row-top">
                <span className={`status-tag ${cls}`}>{ev.status}</span>
                <span className="event-detail">
                  retry {ev.retry_count}/{ev.max_retries}
                </span>
              </div>
              <div className="event-row-meta">
                {ev.started_at && (
                  <span>
                    started {new Date(ev.started_at).toLocaleTimeString()}
                  </span>
                )}
                {ev.completed_at && (
                  <span>
                    finished {new Date(ev.completed_at).toLocaleTimeString()}
                  </span>
                )}
                {ev.started_at && ev.completed_at && (
                  <span>
                    {(
                      (new Date(ev.completed_at).getTime() -
                        new Date(ev.started_at).getTime()) /
                      1000
                    ).toFixed(2)}
                    s
                  </span>
                )}
              </div>
              {ev.error_msg && (
                <span className="event-error">{ev.error_msg}</span>
              )}
            </div>
          );
        })}
        {compact && timeline.length > 4 && (
          <span className="compact-more">
            +{timeline.length - 4} older events
          </span>
        )}
      </div>
    </div>
  );
}
