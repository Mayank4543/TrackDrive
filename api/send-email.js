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
    return { sent: false, reason: "EMAIL_USER or EMAIL_PASS environment variable is missing" };
  }

  // Determine acceptance status
  const postSuccess =
    postResult?.success === true ||
    postResult?.status === "accepted" ||
    Boolean(postResult?.forwarding_number);
  const pingSuccess = pingResult?.success === true && Boolean(pingResult?.buyers?.length);

  let leadStatusBanner = "";
  let statusTag = "";

  if (postSuccess) {
    statusTag = "[LEAD ACCEPTED]";
    leadStatusBanner = ` LEAD ACCEPTED BY TRACKDRIVE
Forwarding Number : ${postResult?.forwarding_number || "Accepted"}
SIP Address       : ${postResult?.forwarding_number_sip_address || "—"}`;
  } else if (pingSuccess) {
    statusTag = "[PING ACCEPTED - POST PENDING]";
    leadStatusBanner = ` PING ACCEPTED (BUYER FOUND), BUT POST REJECTED
Post Error / Response: ${JSON.stringify(postResult?.errors || postResult || "Failed")}`;
  } else {
    statusTag = "[LEAD REJECTED - NO BUYER]";
    leadStatusBanner = ` LEAD REJECTED BY TRACKDRIVE
Reason / Ping Status : ${pingResult?.status || pingResult?.errors?.[0] || "No buyers matched filter criteria"}`;
  }

  const or = (v) => (v === undefined || v === null || v === "" ? "—" : v);

  const message = `

TRACKDRIVE LEAD STATUS: ${statusTag}

${leadStatusBanner}

New TrackDrive Lead — InfoWorx check_fe_agents
trackdrive_number : ${TRACKDRIVE_NUMBER}
traffic_source_id : ${TRAFFIC_SOURCE_ID}

━━━ LEAD DATA SUBMITTED ━━━━━━━━━━━━━━━━━━━━━━━━━━━
${Object.entries(lead || {})
  .map(([k, v]) => `${k.padEnd(28)}: ${or(v)}`)
  .join("\n")}

━━━ PING REQUEST LOG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL: ${pingUrl}
Response:
${pingResult ? JSON.stringify(pingResult, null, 2) : "—"}

━━━ POST REQUEST LOG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
URL: ${postUrl || "—"}
Response:
${postResult ? JSON.stringify(postResult, null, 2) : "—"}

${error ? `━━━ ERROR LOG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${error}\n` : ""}
`.trim();

  try {
    const emailPass = (process.env.EMAIL_PASS || "").replace(/\s+/g, "");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: emailPass },
    });

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.LEAD_RECEIVER_EMAIL || "codemynk234@gmail.com",
      subject:
        `${statusTag} TrackDrive Lead – ${lead?.first_name || ""} ${lead?.last_name || ""}`.trim(),
      text: message,
    });

    console.log("Email sent successfully:", info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (emailErr) {
    console.error("Failed to send email:", emailErr);
    return { sent: false, error: emailErr.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let lead = {};

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    let callerId = data?.caller_id ? digitsOnly(data.caller_id) : "";
    if (callerId.length === 10) {
      callerId = `+1${callerId}`;
    } else if (callerId.length === 11 && callerId.startsWith("1")) {
      callerId = `+${callerId}`;
    }

    // ── Validation for Required Fields ──────────────────────────────
    const errors = {};
    const callerDigits = digitsOnly(callerId);
    if (!callerDigits || !(callerDigits.length === 10 || callerDigits.length === 11)) {
      errors.caller_id = "is required and must be 10–11 digits";
    }
    if (!data?.first_name) errors.first_name = "is required";
    if (!data?.last_name) errors.last_name = "is required";
    if (!data?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      errors.email = "is required and must be a valid email address";
    }
    if (!data?.address) errors.address = "is required";
    if (!data?.trusted_form_cert_url) errors.trusted_form_cert_url = "is required";

    // Handle DOB: calculate `dob` (YYYY-MM-DD) if dob_yyyy, dob_mm, dob_dd are available
    let dob = data.dob || "";
    const dob_yyyy = data.dob_yyyy || "";
    const dob_mm = data.dob_mm || "";
    const dob_dd = data.dob_dd || "";

    if (!dob && dob_yyyy && dob_mm && dob_dd) {
      dob = `${dob_yyyy}-${dob_mm.padStart(2, "0")}-${dob_dd.padStart(2, "0")}`;
    }
    if (!dob) errors.dob = "is required";

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
      address: data.address,
      dob,
      dob_mm,
      dob_dd,
      dob_yyyy,
      trusted_form_cert_url: data.trusted_form_cert_url,
      source_url: data.source_url || "",
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
      console.error("Ping network error:", networkErr.message);
      pingResult = { error: networkErr.message };
    }

    const buyers = pingResult?.buyers || [];
    // Extract ping_id or fallback to try_all_buyers
    const pingId =
      buyers[0]?.ping_id ||
      pingResult?.try_all_buyers_ping_id ||
      pingResult?.try_all_buyers?.ping_id ||
      "";

    let postRes = null, postResult = null;

    // ── 2) POST ───────────────────────────────────────────────────────
    // Only call POST if pingId exists (TrackDrive requires a valid ping_id on POST)
    if (pingId) {
      const postPayload = { ...lead, ping_id: pingId };
      const postParams = toParams(postPayload);

      try {
        postRes = await fetch(POST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: postParams.toString(),
        });
        postResult = await postRes.json();
      } catch (networkErr) {
        console.error("Post network error:", networkErr.message);
        postResult = { error: networkErr.message };
      }
    } else {
      postResult = {
        status: "skipped",
        message: "No buyer available in Ping response to generate a valid ping_id",
      };
    }

    const isPostSuccess = postResult?.success === true || postResult?.status === "accepted";

    const emailStatus = await sendDebugEmail({
      lead,
      pingUrl: pingFullUrl,
      pingResult,
      postUrl: POST_URL,
      postResult,
    });

    return res.status(200).json({
      success: true,
      leadAccepted: isPostSuccess || pingResult?.success === true,
      forwardingNumber: postResult?.forwarding_number || "",
      forwardingNumberSip: postResult?.forwarding_number_sip_address || "",
      pingResponse: pingResult,
      postResponse: postResult,
      emailStatus,
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
