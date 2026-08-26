import nodemailer from "nodemailer";

// ── TrackDrive / InfoWorx config ──────────────────────────────────────
// These two values are fixed per your TrackDrive account setup (see the
// posting instructions doc for InboundWebhook check_fe_agents).
const TRACKDRIVE_NUMBER = "+18337160382";
const TRAFFIC_SOURCE_ID = "IW7834RON";

const PING_URL =
  "https://infoworx.trackdrive.com/api/v1/inbound_webhooks/ping/check_fe_agents";
const POST_URL =
  "https://infoworx.trackdrive.com/api/v1/inbound_webhooks/post/check_fe_agents";

const ALLOWED_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);

function digitsOnly(value) {
  return (value || "").toString().replace(/\D/g, "");
}

// Returns the first valid public IPv4 from request headers
function getRealIp(req) {
  const sources = [
    req.headers["x-forwarded-for"],
    req.headers["x-real-ip"],
    req.headers["cf-connecting-ip"],
  ];

  for (const src of sources) {
    if (!src) continue;
    for (const candidate of src.split(",")) {
      const ip = candidate.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
      const [a, b] = ip.split(".").map(Number);
      if (a === 10) continue;
      if (a === 127) continue;
      if (a === 172 && b >= 16 && b <= 31) continue;
      if (a === 192 && b === 168) continue;
      return ip;
    }
  }
  return "";
}

// Builds a URLSearchParams from an object, skipping empty values
function toParams(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, value);
    }
  });
  return params;
}

async function sendDebugEmail({
  lead,
  pingUrl,
  pingResult,
  postUrl,
  postResult,
  error,
}) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("EMAIL_USER/EMAIL_PASS not set — skipping debug email.");
    return;
  }

  const or = (v) => (v === undefined || v === null || v === "" ? "—" : v);

  const message = `
New TrackDrive Lead — InfoWorx check_fe_agents
trackdrive_number: ${TRACKDRIVE_NUMBER}
traffic_source_id: ${TRAFFIC_SOURCE_ID}

━━━ LEAD DATA SUBMITTED ━━━━━━━━━━━━━━━━━━━━━━━━━━━
${Object.entries(lead)
  .map(([k, v]) => `${k.padEnd(28)}: ${or(v)}`)
  .join("\n")}

━━━ PING REQUEST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL: ${pingUrl}
Response:
${pingResult ? JSON.stringify(pingResult, null, 2) : "—"}

━━━ POST REQUEST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL: ${postUrl || "— (not sent — no buyer available on ping)"}
Response:
${postResult ? JSON.stringify(postResult, null, 2) : "—"}

${error ? `━━━ ERROR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${error}\n` : ""}
`.trim();

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const isAccepted = Boolean(pingResult?.success && postResult?.forwarding_number);
  const statusTag = isAccepted
    ? "[ACCEPTED]"
    : pingResult?.success
    ? "[NO BUYER AVAILABLE]"
    : "[REJECTED/FAILED]";

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.LEAD_RECEIVER_EMAIL || "mailtoakash@gmail.com",
    subject:
      `${statusTag} TrackDrive Lead – ${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
    text: message,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let lead = {};

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const callerId = data?.caller_id ? digitsOnly(data.caller_id) : "";
    const alternatePhone = data?.alternate_phone
      ? digitsOnly(data.alternate_phone)
      : "";
    const state = data?.state ? data.state.toUpperCase() : "";

    // ── Validation ────────────────────────────────────────────────────
    // Nothing is required by TrackDrive itself — only trackdrive_number,
    // traffic_source_id (both fixed below), and ping_id (added after the
    // ping response) are actually required. Everything else is optional;
    // we only validate FORMAT for fields the caller chose to include.
    const errors = {};
    if (callerId && !(callerId.length === 10 || callerId.length === 11))
      errors.caller_id = "must be 10–11 digits if provided";
    if (
      alternatePhone &&
      !(alternatePhone.length === 10 || alternatePhone.length === 11)
    )
      errors.alternate_phone = "must be 10–11 digits if provided";
    if (state && !ALLOWED_STATES.has(state))
      errors.state = "must be a valid 2-letter US state if provided";
    if (data?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
      errors.email = "must be a valid email if provided";

    if (Object.keys(errors).length) {
      return res.status(400).json({ status: 4, errors: [errors] });
    }

    // IP always comes from request headers — never trust user input for this
    const ipAddress = getRealIp(req);

    lead = {
      trackdrive_number: TRACKDRIVE_NUMBER,
      traffic_source_id: TRAFFIC_SOURCE_ID,
      caller_id: callerId,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      zip: data.zip,
      city: data.city || "",
      state,
      address: data.address || "",
      alternate_phone: alternatePhone,
      dob_mm: data.dob_mm || "",
      dob_dd: data.dob_dd || "",
      dob_yyyy: data.dob_yyyy || "",
      gender: data.gender || "",
      marital_status: data.marital_status || "",
      employment_status: data.employment_status || "",
      spoken_language: data.spoken_language || "",
      best_time_to_contact: data.best_time_to_contact || "",
      payment_method_available: data.payment_method_available || "",
      monthly_affordable_payment_amount:
        data.monthly_affordable_payment_amount || "",
      trusted_form_cert_url: data.trusted_form_cert_url,
      jornaya_leadid: data.jornaya_leadid || "",
      tcpa_opt_in: data.tcpa_opt_in || "false",
      tcpa_optin_consent_language: data.tcpa_optin_consent_language || "",
      sub_id: data.sub_id || "",
      traffic_source_lead_id: data.traffic_source_lead_id || "",
      source_url: data.source_url || "",
      useragent: data.useragent || "",
      ip_address: ipAddress,
    };

    // ── 1) PING ───────────────────────────────────────────────────────
    const pingParams = toParams(lead);
    const pingFullUrl = `${PING_URL}?${pingParams.toString()}`;

    let pingRes, pingResult;
    try {
      pingRes = await fetch(pingFullUrl, { method: "GET" });
      pingResult = await pingRes.json();
    } catch (networkErr) {
      await sendDebugEmail({
        lead,
        pingUrl: pingFullUrl,
        pingResult: null,
        error: `Ping network error: ${networkErr.message}`,
      });
      return res
        .status(502)
        .json({
          error: "Could not reach TrackDrive ping endpoint.",
          detail: networkErr.message,
        });
    }

    const buyers = pingResult?.buyers || [];
    const pingAccepted = pingResult?.success === true && buyers.length > 0;

    if (!pingAccepted) {
      await sendDebugEmail({
        lead,
        pingUrl: pingFullUrl,
        pingResult,
      });
      return res.status(200).json({
        success: true,
        pingAccepted: false,
        pingStatus: pingResult?.status || "no buyers available",
        pingResponse: pingResult,
      });
    }

    // Use the ping_id from the first available buyer (fallback to the
    // try_all_buyers ping_id if a per-buyer one isn't present).
    const pingId = buyers[0]?.ping_id || pingResult?.try_all_buyers_ping_id;

    // ── 2) POST ───────────────────────────────────────────────────────
    const postPayload = { ...lead, ping_id: pingId };
    const postParams = toParams(postPayload);

    let postRes, postResult;
    try {
      postRes = await fetch(POST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: postParams.toString(),
      });
      postResult = await postRes.json();
    } catch (networkErr) {
      await sendDebugEmail({
        lead,
        pingUrl: pingFullUrl,
        pingResult,
        postUrl: POST_URL,
        postResult: null,
        error: `Post network error: ${networkErr.message}`,
      });
      return res
        .status(502)
        .json({
          error: "Could not reach TrackDrive post endpoint.",
          detail: networkErr.message,
        });
    }

    await sendDebugEmail({
      lead,
      pingUrl: pingFullUrl,
      pingResult,
      postUrl: POST_URL,
      postResult,
    });

    return res.status(200).json({
      success: true,
      pingAccepted: true,
      forwardingNumber: postResult?.forwarding_number || "",
      forwardingNumberSip: postResult?.forwarding_number_sip_address || "",
      pingResponse: pingResult,
      postResponse: postResult,
    });
  } catch (error) {
    console.error("Handler error:", error);
    try {
      await sendDebugEmail({
        lead,
        pingUrl: PING_URL,
        pingResult: null,
        error: error.message,
      });
    } catch (_) {
      // ignore secondary email failure
    }
    return res
      .status(500)
      .json({ error: "Internal server error", detail: error.message });
  }
}
