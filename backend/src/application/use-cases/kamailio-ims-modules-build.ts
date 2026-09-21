import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same shape as osmo-msc-build.ts / osmo-sip-connector-build.ts. Quick one-off
// host commands; the multi-minute build itself runs as a detached streamed
// script (see ims-controller.ts's /install), not through this.
export const nsenter = async (
  cmd: string,
  args: string[] = [],
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

export const BUILD_WORKDIR = '/opt/kamailio-ims-modules-build';
export const MODULES_DIR = '/usr/lib/x86_64-linux-gnu/kamailio/modules';

// Bump whenever a patch below is added/changed.
export const PATCH_REV = 2;

// Unique string only present once a file has been patched — used both as the
// source-level idempotency check (grepped against the .c file mid-build,
// before compilation strips it) and to tell "already applied" apart from a
// real patch failure, since `patch`'s own exit code conflates the two.
// Deliberately NOT checked against the compiled .so at the top-level
// short-circuit below — comments don't survive compilation, so grepping the
// binary for this string can never match; the top-level skip instead relies
// on the .apt-original + patch-rev markers, which do reflect binary state.
export const CMD_C_MARKER = 'NMS patch, confirmed live 2026-09-12 against a real iOS UE';
export const SAVE_C_MARKER = 'same fallback shape as';
export const CCR_C_MARKER = 'NMS patch, confirmed live 2026-09-17 against a real SigScale OCS';
export const ROC_C_MARKER = 'this deployment\'s own';

// Real bug, root-caused and fixed live 2026-09-12 against the stock (unmodified)
// ims_ipsec_pcscf Kamailio module (kamailio-ims-modules package, NOT this
// project's own code): P-CSCF failed fresh, server-initiated deliveries to a
// UE's real IPsec tunnel with "No security parameters found in contact",
// because ipsec_create() unconditionally hard-failed whenever
// pcontact->security_temp was NULL -- which is the NORMAL state for a contact
// record keyed by a UE's newly-negotiated protected port on its first
// successful registration (the 401 challenge's own ipsec_create() call
// populated security_temp on a DIFFERENT contact record, keyed by the UE's
// original unprotected port -- nothing links the two). A second, independent
// bug in the same function (found later the same night, chasing a full
// "IMS-to-IMS calling is broken" regression): fill_contact() never sets
// ci.reg_state, and ims_usrloc_pcscf/udomain.c's update_pcontact() does an
// unconditional `_c->reg_state = _ci->reg_state` (no preserve-if-unset guard,
// unlike expires) -- so ipsec_create(), which fires on every REGISTER
// challenge/re-auth cycle, silently stomped reg_state back to 0 moments after
// it was correctly promoted elsewhere, on every single UE, not just 2G-interop
// ones. See CMD_C_PATCH's own inline comments (preserved from the original
// live patch) for the full mechanism. Full incident writeup: PROJECT_STATE.md,
// Handoff Summary entries for 2026-09-11/12, and memory
// gsm_2g_osmocom_module_progress.md.
export const CMD_C_PATCH = String.raw`--- a/src/modules/ims_ipsec_pcscf/cmd.c
+++ b/src/modules/ims_ipsec_pcscf/cmd.c
@@ -837,13 +837,23 @@
 		goto cleanup;
 	}

-	// Get security parameters
-	if(pcontact->security_temp == NULL) {
-		LM_ERR("No security parameters found in contact\n");
-		goto cleanup;
-	}
-
-	if(pcontact->security_temp->type != SECURITY_IPSEC) {
+	// NMS patch, confirmed live 2026-09-12 against a real iOS UE: this used
+	// to hard-fail here unconditionally whenever security_temp was NULL --
+	// but that's the normal, expected state for a contact record keyed by a
+	// UE's newly-negotiated protected port on its very first successful
+	// registration (as opposed to a later refresh): the 401 challenge's own
+	// ipsec_create() call populated security_temp on a DIFFERENT contact
+	// record (keyed by the UE's original, unprotected port), and nothing
+	// ever links the two. The "re-registration" branch below already
+	// doesn't actually need security_temp -- it derives everything from
+	// req_sec_params (parsed fresh from the current REGISTER request) and
+	// only *optionally* touches security_temp for old_s, already guarded by
+	// a NULL check. So: stop hard-failing here: only fail where
+	// security_temp is actually dereferenced without a request-derived
+	// fallback available, exactly at that point below instead of
+	// pre-emptively here.
+	if(pcontact->security_temp != NULL
+			&& pcontact->security_temp->type != SECURITY_IPSEC) {
 		LM_ERR("Unsupported security type: %d\n",
 				pcontact->security_temp->type);
 		goto cleanup;
@@ -864,7 +874,8 @@

 	// Update contacts only for initial registration, for re-registration the existing contacts shouldn't be updated.
 	if(ci.via_port == SIP_PORT
-			|| (pcontact->security_temp->data.ipsec->port_ps == 0
+			|| (pcontact->security_temp != NULL
+					&& pcontact->security_temp->data.ipsec->port_ps == 0
 					&& pcontact->security_temp->data.ipsec->port_pc == 0)) {
 		LM_DBG("Registration for contact with AOR [%.*s], VIA [%d://%.*s:%d], "
 			   "received_host [%d://%.*s:%d]\n",
@@ -872,10 +883,20 @@
 				ci.via_host.s, ci.via_port, ci.received_proto,
 				ci.received_host.len, ci.received_host.s, ci.received_port);

-		if(req_sec_params == NULL)
+		if(req_sec_params == NULL) {
+			// NMS patch: previously an unconditional (and, per the removed
+			// check above, now possibly NULL) dereference -- guard it
+			// explicitly instead of relying on the check that used to sit
+			// above this whole if/else.
+			if(pcontact->security_temp == NULL) {
+				LM_ERR("No security parameters found in contact or "
+					   "request\n");
+				goto cleanup;
+			}
 			s = pcontact->security_temp->data.ipsec;
-		else
+		} else {
 			s = req_sec_params->data.ipsec;
+		}
 	} else {
 		LM_DBG("RE-Registration for contact with AOR [%.*s], VIA "
 			   "[%d://%.*s:%d], received_host [%d://%.*s:%d]\n",
@@ -917,6 +938,17 @@
 		}
 	}

+	// NMS patch, confirmed live 2026-09-12: fill_contact() never sets
+	// ci.reg_state, and update_pcontact() (ims_usrloc_pcscf/udomain.c)
+	// unconditionally does "_c->reg_state = _ci->reg_state" with no
+	// preserve-if-unset guard (unlike expires, which it only overwrites
+	// when > 0). Left as-is, this call -- which fires on every REGISTER's
+	// 401/challenge processing, including refresh cycles well after the
+	// contact was already promoted to PCONTACT_REGISTERED -- silently
+	// stomps reg_state back to 0 (PCONTACT_ANY). Since ipsec_create() has
+	// no business changing registration state at all, preserve whatever
+	// the contact already had.
+	ci.reg_state = pcontact->reg_state;
 	if(ul.update_pcontact(d, &ci, pcontact) != 0) {
 		LM_ERR("Error updating contact\n");
 		goto cleanup;
`;

// Real bug, root-caused and fixed live 2026-09-12 in the stock (unmodified)
// ims_registrar_pcscf Kamailio module: save.c's update_contacts() (fired on
// the authenticated REGISTER's 200 OK, the only place that promotes a contact
// to PCONTACT_REGISTERED) looked up the existing pending contact by the
// request's real received port -- but that 200 OK arrives over the UE's
// newly-established IPsec tunnel, on a different port than the original,
// unprotected REGISTER that created the pending row. The lookup missed, so
// the promotion silently never ran, which left every affected UE's
// reg_state stuck at 0 forever -- confirmed as the actual root cause of both
// a 2G-interop-specific report ("04 to 02 doesn't work") and a completely
// separate, general regression report ("IMS to IMS is not working"), since
// ims_usrloc_pcscf's get_pcontact_from_cache() does a strict reg_state match
// that silently treats a real, fully-matching contact as "not found" when
// its reg_state is wrong. Fixed with a via-URI-based fallback search before
// giving up -- same shape as this same module's own getContactP() /
// is_registered_fallback2ip.
export const SAVE_C_PATCH = String.raw`--- a/src/modules/ims_registrar_pcscf/save.c
+++ b/src/modules/ims_registrar_pcscf/save.c
@@ -228,19 +228,38 @@
 				}

 				ul.lock_udomain(_d, &puri.host, port, puri.proto);
-				if(ul.get_pcontact(_d, &ci, &pcontact, 0)
-						!= 0) { //need to insert new contact
-					if((expires - local_time_now)
-							<= 0) { //remove contact - de-register
-						LM_DBG("This is a de-registration for contact <%.*s> "
-							   "but contact is not in usrloc - ignore\n",
-								c->uri.len, c->uri.s);
+				if(ul.get_pcontact(_d, &ci, &pcontact, 0) != 0) {
+					/* Not found via received-port match: the real received
+					 * port can differ from the pending contact's (recorded
+					 * before IPsec was established, eg on the initial
+					 * unprotected REGISTER) once the authenticated REGISTER
+					 * arrives over the newly-established protected tunnel on
+					 * a different port. Retry matching on the Contact URI
+					 * itself (via_host/via_port), which stays stable across
+					 * that port change - same fallback shape as
+					 * getContactP()'s is_registered_fallback2ip. */
+					int found_via_fallback;
+					ci.searchflag = SEARCH_NORMAL;
+					found_via_fallback =
+							(ul.get_pcontact(_d, &ci, &pcontact, 0) == 0);
+					ci.searchflag = SEARCH_RECEIVED;
+					if(!found_via_fallback) { //need to insert new contact
+						if((expires - local_time_now)
+								<= 0) { //remove contact - de-register
+							LM_DBG("This is a de-registration for contact <%.*s> "
+								   "but contact is not in usrloc - ignore\n",
+									c->uri.len, c->uri.s);
+							goto next_contact;
+						}
+						LM_DBG("We don't add contact from the 200OK that did not "
+							   "go through us (ie, not present in explicit "
+							   "REGISTER that went through us\n");
 						goto next_contact;
 					}
-					LM_DBG("We don't add contact from the 200OK that did not "
-						   "go through us (ie, not present in explicit "
-						   "REGISTER that went through us\n");
-				} else { //contact already exists - update
+					LM_DBG("contact found via via-based fallback search "
+						   "(received port changed since pending REGISTER)\n");
+				}
+				{ //contact already exists - update
 					LM_DBG("contact already exists and is in state (%d) : "
 						   "[%s]\n",
 							pcontact->reg_state,
`;

// Four real bugs, all in the stock (unmodified) ims_charging Kamailio module
// (kamailio-ims-modules package), root-caused and fixed live 2026-09-17 while
// wiring the first-ever Diameter Ro (voice/airtime charging) connection this
// deployment has made -- the module has shipped compiled and loaded since
// this project's own IMS install existed, but nothing ever actually
// exercised its CCR-building code path until tonight (WITH_RO stayed
// dormant behind an #!ifdef the whole time, see CLAUDE.md architectural
// pattern #13's Rx interface for the same "built, left disabled" shape).
// Each bug produced a real, reproduced rejection from a real SigScale OCS
// (Erlang/OTP, strict dictionary-based Diameter decoding) -- confirmed via
// OCS's own erlang.log, not guessed, before being patched:
//   1. Ro_write_CCR_avps() (ccr.c) manually re-added Origin-Host/
//      Origin-Realm AVPs that cdp's own AAANewMessage() (called via
//      AAACreateRequest() inside Ro_new_ccr()) already unconditionally adds
//      from the peer's own configured DiameterPeer identity -- OCS rejected
//      every CCR outright with "DIAMETER AVP too many times" (result 5009).
//      This one was config-triggered (the origin_host/origin_realm
//      modparams in kamailio_scscf.cfg's own #!ifdef WITH_RO block set the
//      values Ro_write_CCR_avps() then duplicated) -- see that template's
//      own comment for the matching config-side half of this fix; the
//      modparams are now left unset there since this module already covers
//      the identity via cdp automatically.
//   2. The same function unconditionally added Accounting-Record-Type/
//      Number AVPs to every CCR -- those belong to the Diameter Base
//      Accounting application (RFC 6733 section 9), not Credit-Control (RFC
//      4006); a real CCR has no defined slot for them. OCS rejected with
//      "DIAMETER AVP unsupported" (result 5001).
//   3. No CCR ever carried a standalone top-level Auth-Application-Id AVP,
//      which RFC 4006 section 3.1 requires -- only a copy nested inside
//      Vendor-Specific-Application-Id (Ro_add_vendor_specific_appid(), see
//      bug 4). OCS flagged the missing top-level AVP explicitly (result
//      5005, DIAMETER_MISSING_AVP).
//   4. Every CCR also carried a Vendor-Specific-Application-Id AVP
//      (Ro_add_vendor_specific_appid(), ims_ro.c, three call sites) -- that
//      AVP has no defined slot in RFC 4006's CCR either; it belongs to
//      CER/CEA capability negotiation, already completed once the peer
//      connection is open. OCS rejected with "DIAMETER AVP unsupported"
//      (result 5001) same as bug 2.
//   5. format_subscription_id() (ims_ro.c) only ever recognized a tel: URI
//      as an MSISDN identity -- this deployment's own P-Asserted-Identity is
//      a sip:<msisdn>@domain URI, which fell through to the generic
//      Subscription_Type_IMPU (SIP-URI) branch. OCS's own subscriber lookup
//      (subscriber_id/3) only checks MSISDN/IMSI Subscription-Id types by
//      default, and this deployment's OCS subscriber records are keyed by
//      bare MSISDN, not a full SIP URI string -- every CCR was rejected
//      DIAMETER_USER_UNKNOWN (result 5030) even for a correctly-provisioned
//      subscriber. Fixed by extracting the digit-only user part of a sip:
//      URI the same way a tel: URI's digits already are, falling back to
//      the original IMPU default for anything that isn't purely digits.
// Confirmed working end-to-end after all five fixes: a real test call's Ro
// result code was 2001 (DIAMETER_SUCCESS) with a real 60-second credit
// reservation granted, a clean CCA on CCR-Terminate, and -- verified
// directly against OCS's own Mnesia bucket record, not just the CCA -- a
// real 5-second debit against the subscriber's granted allowance.
export const CCR_C_PATCH = String.raw`--- a/src/modules/ims_charging/ccr.c
+++ b/src/modules/ims_charging/ccr.c
@@ -277,11 +277,32 @@
 			goto error;
 	}

-	if(!cdp_avp->base.add_Accounting_Record_Type(
-			   &(ccr->avpList), x->acct_record_type))
-		goto error;
-	if(!cdp_avp->base.add_Accounting_Record_Number(
-			   &(ccr->avpList), x->acct_record_number))
+	/* NMS patch, confirmed live 2026-09-17 against a real SigScale OCS: this
+	 * used to unconditionally add Accounting-Record-Type/Number to every
+	 * CCR. Those two AVPs belong to the Diameter Base Accounting
+	 * application (RFC 6733 section 9), not Credit-Control (RFC 4006) -- a
+	 * real CCR has no defined slot for them. OCS's own diameter stack
+	 * (Erlang/OTP, strict dictionary-based decoding) rejected every CCR
+	 * outright with "DIAMETER AVP unsupported" (result 5001) once Ro was
+	 * actually exercised for the first time in this deployment's history --
+	 * a real freeDiameter-based peer may silently tolerate/ignore them, but
+	 * OCS does not. Removed rather than left conditional: nothing in this
+	 * module's own CCR construction is a real Diameter Accounting message,
+	 * so these never belonged here regardless of peer.
+	 */
+
+	/* NMS patch, confirmed live 2026-09-17: RFC 4006 section 3.1 requires a
+	 * standalone top-level Auth-Application-Id AVP on every CCR -- this
+	 * module only ever added one NESTED inside Vendor-Specific-Application-Id
+	 * (see Ro_add_vendor_specific_appid() in ims_ro.c), never a top-level
+	 * one. OCS's own diameter stack flagged the missing top-level AVP
+	 * explicitly (result 5005, DIAMETER_MISSING_AVP). IMS_Ro is the same
+	 * Application-Id constant Ro_new_ccr() already passes to
+	 * AAACreateRequest() and Ro_add_vendor_specific_appid() already uses for
+	 * the nested copy -- reusing it here rather than a separate magic number
+	 * keeps both copies guaranteed identical.
+	 */
+	if(!cdp_avp->base.add_Auth_Application_Id(&(ccr->avpList), IMS_Ro))
 		goto error;

 	if(x->user_name)
`;

export const IMS_RO_C_PATCH = String.raw`--- a/src/modules/ims_charging/ims_ro.c
+++ b/src/modules/ims_charging/ims_ro.c
@@ -158,6 +158,39 @@
 			subscription_id->s += 1;
 			subscription_id->len -= 1;
 		}
+	} else if(strncasecmp(subscription_id->s, "sip:", 4) == 0) {
+		/* NMS patch, confirmed live 2026-09-17: this deployment's own
+		 * P-Asserted-Identity is a sip:<msisdn>@domain URI, not a tel: URI
+		 * -- the stock code fell through to the generic Subscription_Type_
+		 * IMPU (SIP-URI) branch below unconditionally, but OCS's own
+		 * subscriber lookup (subscriber_id/3) only checks MSISDN/IMSI
+		 * Subscription-Id types by default, and this deployment's OCS
+		 * subscriber records are keyed by bare MSISDN, not a full SIP URI
+		 * string -- every CCR was rejected DIAMETER_USER_UNKNOWN (5030)
+		 * even for a correctly-provisioned subscriber. If the SIP URI's
+		 * user part is purely digits (the normal shape for a real phone
+		 * number, as opposed to a named/alphanumeric SIP identity), treat
+		 * it the same way a tel: URI already is -- extract just the digits
+		 * and mark it MSISDN type. Anything that doesn't look like a phone
+		 * number falls through to the original default unchanged.
+		 */
+		str user = {subscription_id->s + 4, subscription_id->len - 4};
+		char *at = memchr(user.s, '@', user.len);
+		int userlen = at ? (int)(at - user.s) : user.len;
+		int i, all_digits = userlen > 0;
+		for(i = 0; i < userlen; i++) {
+			if(user.s[i] < '0' || user.s[i] > '9') {
+				all_digits = 0;
+				break;
+			}
+		}
+		if(all_digits) {
+			*subscription_id_type = Subscription_Type_MSISDN;
+			subscription_id->s = user.s;
+			subscription_id->len = userlen;
+		} else {
+			*subscription_id_type = Subscription_Type_IMPU;
+		}
 	} else {
 		*subscription_id_type =
 				Subscription_Type_IMPU; //default is END_USER_SIP_URI
@@ -806,10 +839,13 @@
 	if(!(ccr = Ro_new_ccr(auth, ro_ccr_data)))
 		goto error;

-	if(!Ro_add_vendor_specific_appid(
-			   ccr, IMS_vendor_id_3GPP, IMS_Ro, 0 /*acct id*/)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-	}
+	/* NMS patch, confirmed live 2026-09-17: Vendor-Specific-Application-Id
+	 * has no defined slot in RFC 4006's CCR command (it belongs to CER/CEA
+	 * capability negotiation, already completed once the peer connection is
+	 * open) -- OCS's own diameter stack rejected every CCR carrying it with
+	 * "DIAMETER AVP unsupported" (result 5001). See Ro_write_CCR_avps()'s
+	 * own patch comment (ccr.c) for the two sibling AVPs fixed the same way.
+	 */
 	ro_session->hop_by_hop += 1;
 	if(!Ro_add_cc_request(ccr, RO_CC_INTERIM, ro_session->hop_by_hop)) {
 		LM_ERR("Problem adding CC-Request data\n");
@@ -1131,9 +1167,9 @@

 	LM_DBG("Created new CCR\n");

-	if(!Ro_add_vendor_specific_appid(ccr, IMS_vendor_id_3GPP, IMS_Ro, 0)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-	}
+	/* NMS patch, confirmed live 2026-09-17 -- see the sibling call site
+	 * above and Ro_write_CCR_avps()'s own patch comment (ccr.c).
+	 */

 	ro_session->hop_by_hop += 1;
 	if(!Ro_add_cc_request(ccr, RO_CC_STOP, ro_session->hop_by_hop)) {
@@ -1449,10 +1485,9 @@
 	if(!(ccr = Ro_new_ccr(cc_acc_session, ro_ccr_data)))
 		goto error;

-	if(!Ro_add_vendor_specific_appid(ccr, IMS_vendor_id_3GPP, IMS_Ro, 0)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-		goto error;
-	}
+	/* NMS patch, confirmed live 2026-09-17 -- see the sibling call sites
+	 * above and Ro_write_CCR_avps()'s own patch comment (ccr.c).
+	 */

 	if(!Ro_add_cc_request(ccr, cc_event_type, cc_event_number)) {
 		LM_ERR("Problem adding CC-Request data\n");
`;

export const IMS_MODULES_BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'fetching_source', 'patching', 'building', 'verifying_abi', 'deploying',
] as const;
export type ImsModulesBuildStep = typeof IMS_MODULES_BUILD_STEPS[number];

// Full build script. Rebuilds/redeploys ims_ipsec_pcscf.so,
// ims_registrar_pcscf.so, and ims_charging.so -- every other kamailio-ims-
// modules .so is left completely untouched. Deliberately does NOT restart
// kamailio-pcscf/kamailio-scscf itself; that's the caller's job
// (ims-controller.ts's /install), same "build now, cut over as an explicit
// separate step" split this project uses for FRR's crash-guard patch and the
// osmo-msc/osmo-sip-connector source builds.
// Idempotent: if all three target .so files already contain the patch
// markers, this is a fast no-op unless force=true.
export function buildKamailioImsModulesScript(force = false): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/kamailio-ims-modules-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/kamailio-ims-modules-build-heartbeat.pid ]; then
    kill "$(cat /tmp/kamailio-ims-modules-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/kamailio-ims-modules-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
IPSEC_SO="${MODULES_DIR}/ims_ipsec_pcscf.so"
REGISTRAR_SO="${MODULES_DIR}/ims_registrar_pcscf.so"
CHARGING_SO="${MODULES_DIR}/ims_charging.so"
PATCH_REV_FILE="${BUILD_WORKDIR}/.patch-rev"

if [ "${force ? '1' : '0'}" != "1" ] \\
    && [ -f "$IPSEC_SO" ] && [ -f "$REGISTRAR_SO" ] && [ -f "$CHARGING_SO" ] \\
    && [ -f "$IPSEC_SO.apt-original" ] && [ -f "$REGISTRAR_SO.apt-original" ] && [ -f "$CHARGING_SO.apt-original" ] \\
    && [ "$(cat "$PATCH_REV_FILE" 2>/dev/null || echo -1)" = "${PATCH_REV}" ]; then
  echo "kamailio-ims-modules patch rev ${PATCH_REV} already deployed -- nothing to do."
  echo "==STEP:done=="
  exit 0
fi
mkdir -p ${BUILD_WORKDIR}

if ! dpkg -s kamailio-ims-modules >/dev/null 2>&1; then
  echo "ERROR: kamailio-ims-modules is not installed yet -- install IMS first."
  exit 1
fi
KAMAILIO_TAG="$(dpkg-query -W -f='\${Version}' kamailio-ims-modules)"
echo "installed kamailio-ims-modules version: $KAMAILIO_TAG"

echo "==STEP:installing_apt_deps=="
start_heartbeat
apt-get update -qq
# Confirmed live 2026-09-12 against the real linked libs of the two already-
# built .so files (ldd): libmnl (netlink, ims_ipsec_pcscf's IPsec SA/policy
# calls) and libxml2 (ims_registrar_pcscf). bison/flex/libssl-dev/build-essential
# are kamailio's own core build requirements.
apt-get install -y \\
  build-essential dpkg-dev bison flex libssl-dev libxml2-dev libmnl-dev pkg-config
stop_heartbeat

echo "==STEP:fetching_source=="
cd ${BUILD_WORKDIR}
rm -rf kamailio-src *.dsc *.tar.* *.build *.changes
start_heartbeat
apt-get source "kamailio-ims-modules=$KAMAILIO_TAG"
stop_heartbeat
SRC_DIR="$(find . -maxdepth 1 -type d -iname 'kamailio-*' | head -1)"
if [ -z "$SRC_DIR" ]; then
  echo "ERROR: apt-get source did not produce a kamailio-* source directory."
  exit 1
fi
mv "$SRC_DIR" kamailio-src
cd kamailio-src
echo "source tree ready: $(pwd)"

echo "==STEP:patching=="
IPSEC_C=src/modules/ims_ipsec_pcscf/cmd.c
REGISTRAR_C=src/modules/ims_registrar_pcscf/save.c

if grep -q "${CMD_C_MARKER}" "$IPSEC_C"; then
  echo "  ok    $IPSEC_C (already patched)"
else
  cat > /tmp/cmd.c.patch <<'PATCHEOF'
${CMD_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cmd.c.patch
  grep -q "${CMD_C_MARKER}" "$IPSEC_C" || { echo "ERROR: $IPSEC_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IPSEC_C"
fi

if grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C"; then
  echo "  ok    $REGISTRAR_C (already patched)"
else
  cat > /tmp/save.c.patch <<'PATCHEOF'
${SAVE_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/save.c.patch
  grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C" || { echo "ERROR: $REGISTRAR_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $REGISTRAR_C"
fi

CCR_C=src/modules/ims_charging/ccr.c
IMS_RO_C=src/modules/ims_charging/ims_ro.c

if grep -q "${CCR_C_MARKER}" "$CCR_C"; then
  echo "  ok    $CCR_C (already patched)"
else
  cat > /tmp/ccr.c.patch <<'PATCHEOF'
${CCR_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ccr.c.patch
  grep -q "${CCR_C_MARKER}" "$CCR_C" || { echo "ERROR: $CCR_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CCR_C"
fi

if grep -q "${ROC_C_MARKER}" "$IMS_RO_C"; then
  echo "  ok    $IMS_RO_C (already patched)"
else
  cat > /tmp/ims_ro.c.patch <<'PATCHEOF'
${IMS_RO_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ims_ro.c.patch
  grep -q "${ROC_C_MARKER}" "$IMS_RO_C" || { echo "ERROR: $IMS_RO_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IMS_RO_C"
fi

echo "==STEP:building=="
start_heartbeat
make modules modules=src/modules/ims_ipsec_pcscf
make modules modules=src/modules/ims_registrar_pcscf
make modules modules=src/modules/ims_charging
stop_heartbeat
echo ${PATCH_REV} > "$PATCH_REV_FILE"

NEW_IPSEC_SO="$(pwd)/src/modules/ims_ipsec_pcscf/ims_ipsec_pcscf.so"
NEW_REGISTRAR_SO="$(pwd)/src/modules/ims_registrar_pcscf/ims_registrar_pcscf.so"
NEW_CHARGING_SO="$(pwd)/src/modules/ims_charging/ims_charging.so"
test -f "$NEW_IPSEC_SO" || { echo "ERROR: build did not produce $NEW_IPSEC_SO"; exit 1; }
test -f "$NEW_REGISTRAR_SO" || { echo "ERROR: build did not produce $NEW_REGISTRAR_SO"; exit 1; }
test -f "$NEW_CHARGING_SO" || { echo "ERROR: build did not produce $NEW_CHARGING_SO"; exit 1; }

echo "==STEP:verifying_abi=="
# Confirmed-live discipline from the original manual patch: a bad build could
# still link and produce a .so, but with a different exported-symbol set than
# what kamailio's module loader expects -- diffing the dynamic symbol table
# against the currently-loaded module (patched or original, whichever is
# live right now) catches that before it ever reaches a running service.
for pair in "$IPSEC_SO:$NEW_IPSEC_SO:ims_ipsec_pcscf" "$REGISTRAR_SO:$NEW_REGISTRAR_SO:ims_registrar_pcscf" "$CHARGING_SO:$NEW_CHARGING_SO:ims_charging"; do
  OLD="\${pair%%:*}"; rest="\${pair#*:}"; NEW="\${rest%%:*}"; NAME="\${rest##*:}"
  nm -D --defined-only "$OLD" 2>/dev/null | awk '{print $NF}' | sort > /tmp/"$NAME".old.symbols
  nm -D --defined-only "$NEW" 2>/dev/null | awk '{print $NF}' | sort > /tmp/"$NAME".new.symbols
  if ! diff -q /tmp/"$NAME".old.symbols /tmp/"$NAME".new.symbols > /dev/null; then
    echo "ERROR: $NAME.so exported-symbol table differs from the currently-loaded module -- refusing to deploy. Diff:"
    diff /tmp/"$NAME".old.symbols /tmp/"$NAME".new.symbols || true
    exit 1
  fi
  echo "  ABI ok: $NAME"
done

echo "==STEP:deploying=="
# Preserve the true original exactly once -- never overwrite an existing
# .apt-original with an already-patched file on a re-run.
[ -f "$IPSEC_SO.apt-original" ] || cp "$IPSEC_SO" "$IPSEC_SO.apt-original"
[ -f "$REGISTRAR_SO.apt-original" ] || cp "$REGISTRAR_SO" "$REGISTRAR_SO.apt-original"
[ -f "$CHARGING_SO.apt-original" ] || cp "$CHARGING_SO" "$CHARGING_SO.apt-original"
cp "$NEW_IPSEC_SO" "$IPSEC_SO.new" && mv "$IPSEC_SO.new" "$IPSEC_SO"
cp "$NEW_REGISTRAR_SO" "$REGISTRAR_SO.new" && mv "$REGISTRAR_SO.new" "$REGISTRAR_SO"
cp "$NEW_CHARGING_SO" "$CHARGING_SO.new" && mv "$CHARGING_SO.new" "$CHARGING_SO"
chmod 644 "$IPSEC_SO" "$REGISTRAR_SO" "$CHARGING_SO"
echo "deployed: $IPSEC_SO"
echo "deployed: $REGISTRAR_SO"
echo "deployed: $CHARGING_SO"
echo "originals preserved as *.apt-original for instant revert"

echo "==STEP:done=="
`;
}

// Real check — reads the actual deployed files, not the build log.
// Found live 2026-09-18 (chasing an unrelated reproducibility audit) that
// this had been broken since it was first written: CMD_C_MARKER/
// SAVE_C_MARKER/CCR_C_MARKER are C *comments* in the patch diffs, and
// comments never survive compilation into a .so's string table — `strings`
// can never find them, so every *Patched flag always returned false
// regardless of whether the patch was actually applied. Never caught before
// because nothing in this codebase ever calls this function (confirmed via
// a full grep) — the real deploy pipeline verifies success its own way (the
// ABI `nm -D` exported-symbol diff step already baked into the generated
// script below), so this dead diagnostic function's own bug never blocked
// anything real. Fixed to compare compiled file SIZE against the preserved
// `.apt-original` — a patched ims_charging.so is genuinely, substantially
// larger than the stock package build (confirmed live: 1,138,328 bytes vs
// 476,584 original), a real signal that survives compilation, unlike a
// comment string.
export async function verifyKamailioImsModulesPatch(): Promise<{
  ipsecPatched: boolean;
  registrarPatched: boolean;
  chargingPatched: boolean;
  originalsPreserved: boolean;
}> {
  const sizeDiffers = async (so: string): Promise<boolean> => {
    try {
      const { stdout } = await nsenter('bash', ['-c',
        `stat -c%s ${MODULES_DIR}/${so}.so 2>/dev/null; stat -c%s ${MODULES_DIR}/${so}.so.apt-original 2>/dev/null`]);
      const [current, original] = stdout.trim().split('\n').map(n => parseInt(n, 10));
      return Number.isFinite(current) && Number.isFinite(original) && current !== original;
    } catch { return false; }
  };
  try {
    const [ipsecPatched, registrarPatched, chargingPatched] = await Promise.all([
      sizeDiffers('ims_ipsec_pcscf'), sizeDiffers('ims_registrar_pcscf'), sizeDiffers('ims_charging'),
    ]);
    const { stdout: originals } = await nsenter('bash', ['-c',
      `test -f ${MODULES_DIR}/ims_ipsec_pcscf.so.apt-original && test -f ${MODULES_DIR}/ims_registrar_pcscf.so.apt-original && test -f ${MODULES_DIR}/ims_charging.so.apt-original && echo yes || echo no`]);
    return { ipsecPatched, registrarPatched, chargingPatched, originalsPreserved: originals.trim() === 'yes' };
  } catch {
    return { ipsecPatched: false, registrarPatched: false, chargingPatched: false, originalsPreserved: false };
  }
}
