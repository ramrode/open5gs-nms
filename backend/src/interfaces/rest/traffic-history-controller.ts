import { Router, Request, Response } from 'express';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';

type Resolution = '5m' | '15m' | '1h';

// Also valid PromQL duration literals — used directly as the rate() window.
const RESOLUTION_STEP_SECONDS: Record<Resolution, number> = { '5m': 300, '15m': 900, '1h': 3600 };

interface PromMatrixSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

async function promQueryRange(
  prometheusUrl: string,
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<PromMatrixSeries[]> {
  const url = new URL('/api/v1/query_range', prometheusUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(startSec));
  url.searchParams.set('end', String(endSec));
  url.searchParams.set('step', String(stepSec));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`Prometheus query_range failed: HTTP ${response.status}`);
  }
  const body: any = await response.json();
  if (body.status !== 'success' || body.data?.resultType !== 'matrix') {
    throw new Error(`Unexpected Prometheus response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data.result as PromMatrixSeries[];
}

export const createTrafficHistoryRouter = (
  prometheusUrl: string,
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // ── GET / — time series points for charting, proxied from Prometheus ────────
  router.get('/', async (req: Request, res: Response) => {
    try {
      const scope = (req.query.scope as string) === 'subscriber' ? 'subscriber' : 'aggregate';
      const resolution = ((req.query.resolution as string) ?? '5m') as Resolution;
      const step = RESOLUTION_STEP_SECONDS[resolution];
      if (!step) {
        res.status(400).json({ error: 'resolution must be one of 5m, 15m, 1h' });
        return;
      }

      const imsi = req.query.imsi as string | undefined;
      const dnn = req.query.dnn as string | undefined;
      if (scope === 'subscriber' && !imsi) {
        res.status(400).json({ error: 'imsi is required when scope=subscriber' });
        return;
      }

      const to = req.query.to ? new Date(req.query.to as string) : new Date();
      const from = req.query.from ? new Date(req.query.from as string) : new Date(to.getTime() - 24 * 60 * 60 * 1000);
      const startSec = Math.floor(from.getTime() / 1000);
      const endSec = Math.floor(to.getTime() / 1000);

      const upMetric = scope === 'subscriber' ? 'open5gs_subscriber_up_bytes_total' : 'open5gs_gtp_rx_bytes_total';
      const downMetric = scope === 'subscriber' ? 'open5gs_subscriber_down_bytes_total' : 'open5gs_gtp_tx_bytes_total';
      const labelFilter = scope === 'subscriber' ? `{imsi="${imsi}"}` : dnn ? `{dnn="${dnn}"}` : '';

      const [upResult, downResult] = await Promise.all([
        promQueryRange(prometheusUrl, `rate(${upMetric}${labelFilter}[${resolution}])*8/1e6`, startSec, endSec, step),
        promQueryRange(prometheusUrl, `rate(${downMetric}${labelFilter}[${resolution}])*8/1e6`, startSec, endSec, step),
      ]);

      // Merge up+down series keyed by (ts, dnn|imsi) back into one point per series/timestamp.
      const byKey = new Map<string, { ts: number; dnn?: string; imsi?: string; upMbps: number; downMbps: number }>();
      const labelOf = (metric: Record<string, string>) => (scope === 'subscriber' ? metric.imsi : metric.dnn);

      for (const series of upResult) {
        const label = labelOf(series.metric);
        for (const [ts, val] of series.values) {
          const key = `${ts}|${label ?? ''}`;
          const point = byKey.get(key) ?? {
            ts, upMbps: 0, downMbps: 0,
            ...(scope === 'subscriber' ? { imsi: label } : { dnn: label }),
          };
          point.upMbps = Number(val);
          byKey.set(key, point);
        }
      }
      for (const series of downResult) {
        const label = labelOf(series.metric);
        for (const [ts, val] of series.values) {
          const key = `${ts}|${label ?? ''}`;
          const point = byKey.get(key) ?? {
            ts, upMbps: 0, downMbps: 0,
            ...(scope === 'subscriber' ? { imsi: label } : { dnn: label }),
          };
          point.downMbps = Number(val);
          byKey.set(key, point);
        }
      }

      const points = Array.from(byKey.values())
        .sort((a, b) => a.ts - b.ts)
        .map(p => ({
          ts: new Date(p.ts * 1000).toISOString(),
          dnn: p.dnn,
          imsi: p.imsi,
          upMbps: Number.isFinite(p.upMbps) ? p.upMbps : 0,
          downMbps: Number.isFinite(p.downMbps) ? p.downMbps : 0,
        }));

      res.json({ points });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to query traffic history from Prometheus');
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /period-summary — total data volume per day/week/month, for the
  // per-UE "usage over time" view. Uses PromQL increase() (total counter
  // growth over each window), not rate() — this endpoint answers "how many
  // bytes" per period, not "how many Mbps" at an instant, so it deliberately
  // does NOT reuse the '/' endpoint's rate()-based query. 'month' is
  // approximated as a fixed 30d window (PromQL has no calendar-month
  // duration literal) — acceptable here since Prometheus's own retention is
  // 30 days anyway (see CLAUDE.md), so a precise calendar month rarely
  // matters in practice. query_range's own step==window-size gives
  // non-overlapping buckets, one point per period.
  router.get('/period-summary', async (req: Request, res: Response) => {
    try {
      const imsi = req.query.imsi as string | undefined;
      if (!imsi) {
        res.status(400).json({ error: 'imsi is required' });
        return;
      }
      const period = (req.query.period as string) === 'week' ? 'week'
        : (req.query.period as string) === 'month' ? 'month' : 'day';
      const periodSeconds = period === 'week' ? 7 * 24 * 3600 : period === 'month' ? 30 * 24 * 3600 : 24 * 3600;
      const rangeLit = period === 'week' ? '7d' : period === 'month' ? '30d' : '1d';
      const count = Math.min(Math.max(Number(req.query.count) || 14, 1), 90);

      const endSec = Math.floor(Date.now() / 1000);
      const startSec = endSec - periodSeconds * count;
      const labelFilter = `{imsi="${imsi}"}`;

      const [upResult, downResult] = await Promise.all([
        promQueryRange(prometheusUrl, `increase(open5gs_subscriber_up_bytes_total${labelFilter}[${rangeLit}])`, startSec, endSec, periodSeconds),
        promQueryRange(prometheusUrl, `increase(open5gs_subscriber_down_bytes_total${labelFilter}[${rangeLit}])`, startSec, endSec, periodSeconds),
      ]);

      const byTs = new Map<number, number>();
      for (const series of upResult) {
        for (const [ts, val] of series.values) byTs.set(ts, (byTs.get(ts) ?? 0) + Number(val));
      }
      for (const series of downResult) {
        for (const [ts, val] of series.values) byTs.set(ts, (byTs.get(ts) ?? 0) + Number(val));
      }

      const points = Array.from(byTs.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, bytes]) => ({
          periodStart: new Date(ts * 1000).toISOString(),
          bytes: Number.isFinite(bytes) ? Math.max(bytes, 0) : 0,
        }));

      res.json({ period, points });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to query period summary from Prometheus');
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /subscribers — IMSIs currently tracked, for the filter dropdown ─────
  router.get('/subscribers', async (_req: Request, res: Response) => {
    try {
      const url = new URL('/api/v1/label/imsi/values', prometheusUrl);
      url.searchParams.set('match[]', 'open5gs_subscriber_up_bytes_total');
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      const body: any = await response.json();
      const imsis: string[] = Array.isArray(body?.data) ? body.data : [];

      const nicknameByImsi = await subscriberRepo.getNicknamesByImsi(imsis);
      res.json({
        subscribers: imsis.map(imsi => ({ imsi, nickname: nicknameByImsi[imsi] })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list subscribers with traffic history');
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
