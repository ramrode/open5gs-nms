import { Router, Request, Response } from 'express';
import { Db, ObjectId } from 'mongodb';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { runOcsEval, escapeErlString, erlBinLit } from './ocs-controller';

// ── Charging Plans — simple data + voice caps on top of SigScale OCS ───────
//
// A deliberate, scoped exception to this module's own "link out, don't
// reimplement" rule (CLAUDE.md pattern #17): the operator explicitly asked
// for a simple, two-number (GB + minutes) alternative to OCS's own rating-
// plan GUI, not a general product-offer editor. Full balance/CDR/product-
// catalog management stays in OCS's own web GUI — this only adds "how much
// data" and "how much airtime" per subscriber, via reusable named plans.
//
// OCS data model (every detail below confirmed live against the real running
// node before writing this, not assumed — see memory `sigscale_ocs_module_
// progress.md` and PROJECT_STATE.md for the full research arc):
//   - An #offer{} carries exactly ONE `specification` (rateable service
//     type) — "4"/"8" for Diameter/PS-data (Gy), "5"/"9" for Diameter/IMS-
//     voice (Ro). So one GUI "Plan" = one BUNDLE offer (specification =
//     undefined, bundle = [data sub-offer, voice sub-offer]) — confirmed
//     live: the rating engine resolves a bundle to whichever sub-offer
//     matches the current request's service type, so Gy and Ro requests
//     against the same subscriber draw from independent buckets.
//   - A price's own `size` is a per-request rating GRANULARITY, not the
//     subscriber's total cap. The actual initial balance comes from an
//     `#alteration{type = one_time, units, size, amount}` attached to the
//     price — `ocs:add_product/2` seeds exactly one `#bucket{remain_amount
//     = Size}` from this when the product is first created. Confirmed live:
//     a 5,000,000-octet alteration produced a real bucket with
//     remain_amount=5000000, byte for byte.
//   - Reassigning a subscriber to a different plan is NOT a single call —
//     `add_product` requires the service's `product` field to be
//     `undefined` first, and `delete_product` requires the OLD product's
//     OWN `service` list (not the service's `product` field) to be empty.
//     The verified working sequence: read the old product, remove this
//     identity from ITS `service` list via `update_product`, reset the
//     service's own `product` field to `undefined` via `update_service`,
//     THEN `delete_product` the now-orphaned old product, THEN
//     `add_product` onto the new bundle. `ensurePlanErl()` below is exactly
//     this sequence, expressed once and reused for both first-time
//     assignment (no old product) and reassignment.
//   - No `.hrl` is loadable in the bare `-eval` shell `runOcsEval()` uses
//     (imported from ocs-controller.ts, which also documents this and the
//     "every ocs:* call MUST go through rpc:call into the real node" trap)
//     — every script below uses raw tuple construction/positional
//     `element(N, Tuple)` access, never `#record{}` syntax.
//
// Field positions relied on throughout (from the real -record() defs,
// fetched from github.com/sigscale/ocs, cross-checked live):
//   #service{}: name=2, product=8
//   #product{}: id=2, product(offering ref)=7, balance(bucket ids)=10, service(linked identities)=11
//   #bucket{}:  id=2, remain_amount=7, units=9
//
// Changing an existing plan's caps updates the OCS offer (affects future
// bucket grants for newly-assigned subscribers) but does NOT retroactively
// resize a bucket a subscriber was already granted — OCS has no "resize an
// existing bucket" primitive exposed here; only a fresh grant (a new
// product) does. Documented, not silently glossed over.

const PLAN_SPEC_DATA = '4';
const PLAN_SPEC_VOICE = '5';
const GB_TO_BYTES = 1_000_000_000; // decimal GB, matching carrier convention
const MIN_TO_SECONDS = 60;

function planOfferIds(planId: string): { bundle: string; data: string; voice: string } {
  return {
    bundle: `plan-${planId}-bundle`,
    data: `plan-${planId}-data`,
    voice: `plan-${planId}-voice`,
  };
}

interface ChargingPlanDoc {
  _id: ObjectId;
  name: string;
  dataCapGB: number;
  voiceCapMinutes: number;
  ocsBundleOfferId: string;
  ocsDataOfferId: string;
  ocsVoiceOfferId: string;
  imsis: string[];
  createdAt: number;
}

// Builds+writes the 3 OCS offers (data sub-offer, voice sub-offer, bundle)
// for one plan. `add_offer` under an existing name overwrites in place
// (Mnesia write-by-key, confirmed live during tonight's specification-field
// fix) — safe to call again on plan edit.
async function provisionPlanOffers(
  ids: { bundle: string; data: string; voice: string },
  dataCapGB: number,
  voiceCapMinutes: number,
): Promise<{ ok: boolean; error?: string }> {
  const dataBytes = Math.round(dataCapGB * GB_TO_BYTES);
  const voiceSeconds = Math.round(voiceCapMinutes * MIN_TO_SECONDS);
  const script = [
    `Node = 'ocs@open5gs-core',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    `DataAlt = {alteration, "data-grant", undefined, undefined, undefined, one_time, undefined, octets, ${dataBytes}, 0, undefined},`,
    `DataPrice = {price, "data-usage", undefined, undefined, undefined, usage, undefined, octets, 1000000, 0, "USD", [], DataAlt},`,
    `DataOffer = {offer, "${escapeErlString(ids.data)}", undefined, undefined, undefined, active, "${PLAN_SPEC_DATA}", [], [DataPrice], [], undefined},`,
    `R1 = Ocs(add_offer, [DataOffer]),`,
    `VoiceAlt = {alteration, "voice-grant", undefined, undefined, undefined, one_time, undefined, seconds, ${voiceSeconds}, 0, undefined},`,
    `VoicePrice = {price, "voice-usage", undefined, undefined, undefined, usage, undefined, seconds, 30, 0, "USD", [], VoiceAlt},`,
    `VoiceOffer = {offer, "${escapeErlString(ids.voice)}", undefined, undefined, undefined, active, "${PLAN_SPEC_VOICE}", [], [VoicePrice], [], undefined},`,
    `R2 = Ocs(add_offer, [VoiceOffer]),`,
    `BundledData = {bundled_po, "${escapeErlString(ids.data)}", undefined, undefined, undefined, undefined},`,
    `BundledVoice = {bundled_po, "${escapeErlString(ids.voice)}", undefined, undefined, undefined, undefined},`,
    `BundleOffer = {offer, "${escapeErlString(ids.bundle)}", undefined, undefined, undefined, active, undefined, [BundledData, BundledVoice], [], [], undefined},`,
    `R3 = Ocs(add_offer, [BundleOffer]),`,
    `io:format("PROVISION_RESULT ~p~n", [{R1, R2, R3}]),`,
    `init:stop()`,
  ].join('\n');
  const stdout = await runOcsEval(script, 15000);
  if (!stdout.includes('PROVISION_RESULT {{ok,') || stdout.includes('{error,')) {
    return { ok: false, error: `Unexpected provision result: ${stdout.trim().slice(-600)}` };
  }
  return { ok: true };
}

// Best-effort — a plan's offers may still be referenced by subscribers
// (add_product on the bundle) and delete_offer correctly refuses in that
// case; only called when a plan is confirmed empty (imsis.length === 0).
async function deprovisionPlanOffers(ids: { bundle: string; data: string; voice: string }): Promise<void> {
  const script = [
    `Node = 'ocs@open5gs-core',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    `Ocs(delete_offer, ["${escapeErlString(ids.bundle)}"]),`,
    `Ocs(delete_offer, ["${escapeErlString(ids.data)}"]),`,
    `Ocs(delete_offer, ["${escapeErlString(ids.voice)}"]),`,
    `init:stop()`,
  ].join('\n');
  await runOcsEval(script, 15000).catch(() => {});
}

// The verified reassignment sequence (see module header), expressed once as
// an Erlang helper and reused for every subscriber a bulk /assign call
// touches — batched into ONE eval script per request rather than one
// round-trip per subscriber, matching syncOcsSubscribers()'s own established
// batching pattern.
//
// Takes a LIST of identities per subscriber (IMSI, and MSISDN when known) —
// NOT called once per identity. Real bug, found live 2026-09-17 chasing a
// dashboard usage readout stuck at 0 despite a confirmed real Ro debit: an
// earlier draft called this per-identity, so IMSI and MSISDN each got their
// OWN separate ocs:add_product/2 call and ended up on two entirely
// independent products with independent buckets. Gy (data) keys off IMSI;
// Ro (voice, see ims_charging's format_subscription_id() patch) keys off
// MSISDN — with two separate products, a subscriber's data and voice usage
// silently drew from disconnected pools instead of one shared plan, and any
// usage query keyed on just one identity (like the dashboard's own, keyed on
// IMSI) would never see usage that landed on the other identity's product.
// Every identity for a subscriber must land on the SAME product, so they're
// linked together in one call here.
function ensurePlanErlHelper(): string {
  return [
    `EnsurePlan = fun(Ids, BundleOfferId) ->`,
    `  Svcs = [ case Ocs(find_service, [Id]) of`,
    `    {ok, S} -> S;`,
    `    {error, not_found} ->`,
    `      case Ocs(add_service, [Id, undefined]) of`,
    `        {ok, NewSvc} -> NewSvc;`,
    `        {error, _} -> error`,
    `      end`,
    `  end || Id <- Ids ],`,
    `  case lists:member(error, Svcs) of`,
    `    true -> error;`,
    `    false ->`,
    `      ProductRefs = lists:usort([ element(8, Svc) || Svc <- Svcs ]),`,
    `      AlreadyLinked = case ProductRefs of`,
    `        [SingleRef] when SingleRef =/= undefined ->`,
    `          case Ocs(find_product, [SingleRef]) of`,
    `            {ok, P} -> element(7, P) =:= BundleOfferId;`,
    `            _ -> false`,
    `          end;`,
    `        _ -> false`,
    `      end,`,
    `      case AlreadyLinked of`,
    `        true -> ok;`,
    `        false ->`,
    `          lists:foreach(fun(Id) ->`,
    `            {ok, SvcNow} = Ocs(find_service, [Id]),`,
    `            case element(8, SvcNow) of`,
    `              undefined -> ok;`,
    `              OldProductRef ->`,
    `                case Ocs(find_product, [OldProductRef]) of`,
    `                  {ok, OldProd} ->`,
    `                    OldServices = lists:delete(Id, element(11, OldProd)),`,
    `                    Ocs(update_product, [setelement(11, OldProd, OldServices)]),`,
    `                    {ok, SvcNow2} = Ocs(find_service, [Id]),`,
    `                    Ocs(update_service, [setelement(8, SvcNow2, undefined)]),`,
    `                    case OldServices of`,
    `                      [] -> Ocs(delete_product, [OldProductRef]);`,
    `                      _ -> ok`,
    `                    end;`,
    `                  _ -> ok`,
    `                end`,
    `            end`,
    `          end, Ids),`,
    `          case Ocs(add_product, [BundleOfferId, Ids]) of`,
    `            {ok, _} -> ok;`,
    `            {error, _} -> error`,
    `          end`,
    `      end`,
    `  end`,
    `end,`,
  ].join('\n');
}

// Ensures every (imsi, msisdn?) pair is linked to the given plan's bundle
// offer, moving them off whatever plan they were on before if any. Returns
// per-identity ok/fail counts, not per-subscriber (matches the counting
// convention already established in ocs-controller.ts's syncOcsSubscribers).
async function assignSubscribersToPlan(
  bundleOfferId: string,
  subs: Array<{ imsi: string; msisdn?: string }>,
): Promise<{ ok: boolean; assigned: number; failed: number; error?: string }> {
  if (subs.length === 0) return { ok: true, assigned: 0, failed: 0 };
  const subsLit = subs
    .map(s => `{${erlBinLit(s.imsi)}, ${s.msisdn ? erlBinLit(s.msisdn) : 'undefined'}}`)
    .join(', ');
  const script = [
    `Node = 'ocs@open5gs-core',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    ensurePlanErlHelper(),
    `BundleOfferId = "${escapeErlString(bundleOfferId)}",`,
    `Subs = [${subsLit}],`,
    `Results = [ EnsurePlan(case Msisdn of undefined -> [Imsi]; _ -> [Imsi, Msisdn] end, BundleOfferId) || {Imsi, Msisdn} <- Subs ],`,
    `OkCount = length([ ok || R <- Results, R =:= ok ]),`,
    `FailCount = length(Subs) - OkCount,`,
    `io:format("ASSIGN_RESULT ~p~n", [{ok, OkCount, FailCount}]),`,
    `init:stop()`,
  ].join('\n');
  const stdout = await runOcsEval(script, 30000);
  const m = stdout.match(/ASSIGN_RESULT \{ok,(\d+),(\d+)\}/);
  if (!m) return { ok: false, assigned: 0, failed: subs.length, error: `Unexpected assign result: ${stdout.trim().slice(-600)}` };
  return { ok: true, assigned: Number(m[1]), failed: Number(m[2]) };
}

// One bulk lookup for every currently-assigned identity — never N per-row
// calls, matching this codebase's established pattern (confirmed via the
// Subscribers page's own blocked-UE-set and RadioSignalPage.tsx's polling
// shape). Returns used/total for data (bytes) and voice (seconds); "used" is
// derived as capBytes - remain_amount, so it only reflects usage since the
// subscriber's current bucket was granted — a plan change resets this.
interface SubscriberUsage {
  dataUsedBytes: number;
  dataTotalBytes: number;
  voiceUsedSeconds: number;
  voiceTotalSeconds: number;
}

async function getUsageForImsis(
  imsis: string[],
  dataCapGB: number,
  voiceCapMinutes: number,
): Promise<Record<string, SubscriberUsage | null>> {
  const result: Record<string, SubscriberUsage | null> = {};
  if (imsis.length === 0) return result;
  const dataTotalBytes = Math.round(dataCapGB * GB_TO_BYTES);
  const voiceTotalSeconds = Math.round(voiceCapMinutes * MIN_TO_SECONDS);
  const imsisLit = imsis.map(i => erlBinLit(i)).join(', ');
  const script = [
    `Node = 'ocs@open5gs-core',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    `Imsis = [${imsisLit}],`,
    `GetUsage = fun(Id) ->`,
    `  case Ocs(find_service, [Id]) of`,
    `    {ok, Svc} ->`,
    `      case element(8, Svc) of`,
    `        undefined -> {Id, none};`,
    `        ProdRef ->`,
    `          case Ocs(find_product, [ProdRef]) of`,
    `            {ok, Prod} ->`,
    `              BucketIds = element(10, Prod),`,
    `              Buckets = [ B || BId <- BucketIds, {ok, B} <- [Ocs(find_bucket, [BId])] ],`,
    `              DataRemain = lists:sum([ element(7, B) || B <- Buckets, element(9, B) =:= octets ]),`,
    `              VoiceRemain = lists:sum([ element(7, B) || B <- Buckets, element(9, B) =:= seconds ]),`,
    `              {Id, {DataRemain, VoiceRemain}};`,
    `            _ -> {Id, none}`,
    `          end`,
    `      end;`,
    `    _ -> {Id, none}`,
    `  end`,
    `end,`,
    `Results = [ GetUsage(I) || I <- Imsis ],`,
    `io:format("USAGE_RESULT ~p~n", [Results]),`,
    `init:stop()`,
  ].join('\n');
  const stdout = await runOcsEval(script, 20000);
  // Parse lines like: {<<"001...">>,{4900000,29000}} or {<<"001...">>,none}
  const re = /\{<<"(\d+)">>,\s*(none|\{(\d+),(\d+)\})\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stdout)) !== null) {
    const imsi = match[1];
    if (match[2] === 'none') {
      result[imsi] = null;
      continue;
    }
    const dataRemain = Number(match[3]);
    const voiceRemain = Number(match[4]);
    result[imsi] = {
      dataUsedBytes: Math.max(dataTotalBytes - dataRemain, 0),
      dataTotalBytes,
      voiceUsedSeconds: Math.max(voiceTotalSeconds - voiceRemain, 0),
      voiceTotalSeconds,
    };
  }
  return result;
}

export const DEFAULT_UNLIMITED_PLAN_NAME = 'Unlimited';
// A very large finite cap, not a dedicated "no cap" sentinel/code path.
// This project's OCS integration has a real, still-unresolved
// crash-on-termination bug in the rating engine itself (ocs_rating:charge2,
// see memory sigscale_ocs_module_progress.md) — deliberately avoiding a
// genuinely new "no bucket at all" code path here, which would exercise an
// interaction with that fragile engine nothing else in this deployment ever
// has. A huge cap reuses the exact same, already-verified-working
// bucket/alteration mechanics every other plan already uses. 1,000,000
// GB/min is comfortably beyond any real subscriber's usage and, being a
// round number no operator would type by hand for a real cap, doubles as
// the display threshold for rendering "Unlimited" in the UI.
export const UNLIMITED_DATA_CAP_GB = 1_000_000;
export const UNLIMITED_VOICE_CAP_MINUTES = 1_000_000;

// Auto-provisioned whenever OCS is configured (see ocs-controller.ts's
// /configure route, wired via a lazy import to avoid a circular static
// import — this file already statically imports ocs-controller.ts) so a
// no-cap option exists without the operator building one by hand — explicit
// user request. Idempotent by name: if a plan named "Unlimited" already
// exists, this is a no-op, even if an operator has since edited its caps
// down — re-running Configure won't fight a deliberate edit.
export async function ensureDefaultUnlimitedPlan(db: Db): Promise<{ created: boolean; error?: string }> {
  const col = db.collection<ChargingPlanDoc>('nms_charging_plans');
  const existing = await col.findOne({ name: DEFAULT_UNLIMITED_PLAN_NAME });
  if (existing) return { created: false };

  const _id = new ObjectId();
  const ids = planOfferIds(_id.toHexString());
  const provision = await provisionPlanOffers(ids, UNLIMITED_DATA_CAP_GB, UNLIMITED_VOICE_CAP_MINUTES);
  if (!provision.ok) return { created: false, error: provision.error };

  const doc: ChargingPlanDoc = {
    _id, name: DEFAULT_UNLIMITED_PLAN_NAME,
    dataCapGB: UNLIMITED_DATA_CAP_GB, voiceCapMinutes: UNLIMITED_VOICE_CAP_MINUTES,
    ocsBundleOfferId: ids.bundle, ocsDataOfferId: ids.data, ocsVoiceOfferId: ids.voice,
    imsis: [], createdAt: Date.now(),
  };
  await col.insertOne(doc);
  return { created: true };
}

export function createChargingPlansRouter(
  subscriberRepo: ISubscriberRepository,
  db: Db,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();
  const col = () => db.collection<ChargingPlanDoc>('nms_charging_plans');

  const resolveSubs = async (imsis: string[]): Promise<Array<{ imsi: string; msisdn?: string }>> => {
    const all = await subscriberRepo.findAllFull();
    const byImsi = new Map(all.map(s => [s.imsi, s]));
    return imsis
      .map(imsi => byImsi.get(imsi))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map(s => ({ imsi: s.imsi, msisdn: s.msisdn?.[0] }));
  };

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const plans = await col().find({}).sort({ createdAt: 1 }).toArray();
      res.json({ success: true, data: plans });
    } catch (err) {
      logger.error({ err }, 'Failed to list charging plans');
      res.status(500).json({ success: false, error: 'Failed to list plans' });
    }
  });

  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { name, dataCapGB, voiceCapMinutes } = req.body as { name?: string; dataCapGB?: number; voiceCapMinutes?: number };
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (typeof dataCapGB !== 'number' || dataCapGB <= 0 || typeof voiceCapMinutes !== 'number' || voiceCapMinutes <= 0) {
      return res.status(400).json({ success: false, error: 'dataCapGB and voiceCapMinutes must both be positive numbers' });
    }
    const _id = new ObjectId();
    const ids = planOfferIds(_id.toHexString());
    const provision = await provisionPlanOffers(ids, dataCapGB, voiceCapMinutes);
    if (!provision.ok) {
      await auditLogger.log({ action: 'charging_plan_create', user, details: provision.error ?? 'provisioning failed', success: false });
      return res.status(500).json({ success: false, error: provision.error });
    }
    const doc: ChargingPlanDoc = {
      _id, name: name.trim(), dataCapGB, voiceCapMinutes,
      ocsBundleOfferId: ids.bundle, ocsDataOfferId: ids.data, ocsVoiceOfferId: ids.voice,
      imsis: [], createdAt: Date.now(),
    };
    await col().insertOne(doc);
    await auditLogger.log({ action: 'charging_plan_create', user, details: `name=${doc.name} dataCapGB=${dataCapGB} voiceCapMinutes=${voiceCapMinutes}`, success: true });
    res.json({ success: true, data: doc });
  });

  router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    const plan = await col().findOne({ _id: id });
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    const { name, dataCapGB, voiceCapMinutes } = req.body as { name?: string; dataCapGB?: number; voiceCapMinutes?: number };
    const newDataCapGB = dataCapGB ?? plan.dataCapGB;
    const newVoiceCapMinutes = voiceCapMinutes ?? plan.voiceCapMinutes;
    if (dataCapGB !== undefined || voiceCapMinutes !== undefined) {
      const ids = { bundle: plan.ocsBundleOfferId, data: plan.ocsDataOfferId, voice: plan.ocsVoiceOfferId };
      const provision = await provisionPlanOffers(ids, newDataCapGB, newVoiceCapMinutes);
      if (!provision.ok) {
        await auditLogger.log({ action: 'charging_plan_update', user, details: provision.error ?? 'provisioning failed', success: false });
        return res.status(500).json({ success: false, error: provision.error });
      }
    }
    const update: Partial<ChargingPlanDoc> = { dataCapGB: newDataCapGB, voiceCapMinutes: newVoiceCapMinutes };
    if (name !== undefined) update.name = String(name).trim();
    await col().updateOne({ _id: id }, { $set: update });
    await auditLogger.log({ action: 'charging_plan_update', user, details: `id=${req.params.id}`, success: true });
    res.json({ success: true });
  });

  router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    const plan = await col().findOne({ _id: id });
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    if (plan.imsis.length > 0) {
      return res.status(400).json({ success: false, error: `${plan.imsis.length} subscriber(s) still on this plan — reassign them first.` });
    }
    await deprovisionPlanOffers({ bundle: plan.ocsBundleOfferId, data: plan.ocsDataOfferId, voice: plan.ocsVoiceOfferId });
    await col().deleteOne({ _id: id });
    await auditLogger.log({ action: 'charging_plan_delete', user, details: `name=${plan.name}`, success: true });
    res.json({ success: true });
  });

  // Bulk-assign — mirrors subscriber-groups' merge-into-array update, plus
  // the OCS-side reassignment work and removing these imsis from whichever
  // other plan they may have been on (a subscriber is on exactly one plan
  // at a time, matching OCS's own service.product being a single reference).
  router.post('/:id/assign', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    const plan = await col().findOne({ _id: id });
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    const { imsis } = req.body as { imsis?: string[] };
    if (!Array.isArray(imsis) || imsis.length === 0) {
      return res.status(400).json({ success: false, error: 'imsis (non-empty array) required' });
    }
    const subs = await resolveSubs(imsis);
    if (subs.length === 0) {
      return res.status(400).json({ success: false, error: 'None of the given imsis match a real subscriber' });
    }
    const result = await assignSubscribersToPlan(plan.ocsBundleOfferId, subs);
    if (!result.ok) {
      await auditLogger.log({ action: 'charging_plan_assign', user, details: result.error ?? 'failed', success: false });
      return res.status(500).json({ success: false, error: result.error });
    }
    const assignedImsis = subs.map(s => s.imsi);
    await col().updateMany({ _id: { $ne: id }, imsis: { $in: assignedImsis } }, { $pull: { imsis: { $in: assignedImsis } as any } });
    await col().updateOne({ _id: id }, { $addToSet: { imsis: { $each: assignedImsis } } });
    await auditLogger.log({ action: 'charging_plan_assign', user, details: `plan=${plan.name} assigned=${result.assigned} failed=${result.failed}`, success: true });
    res.json({ success: true, assigned: result.assigned, failed: result.failed });
  });

  // One bulk usage call for every subscriber on this plan.
  router.get('/:id/usage', async (req: Request, res: Response) => {
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    const plan = await col().findOne({ _id: id });
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    try {
      const usage = await getUsageForImsis(plan.imsis, plan.dataCapGB, plan.voiceCapMinutes);
      res.json({ success: true, data: usage });
    } catch (err) {
      logger.error({ err }, 'Failed to get plan usage');
      res.status(500).json({ success: false, error: 'Failed to get usage' });
    }
  });

  return router;
}
