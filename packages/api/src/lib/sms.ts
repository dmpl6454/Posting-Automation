/**
 * SMS service — routes by phone number prefix:
 *   +91 (India)       → Fast2SMS  (FAST2SMS_API_KEY)
 *   Everything else   → Twilio    (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)
 *
 * If neither provider is configured the OTP is logged to the console (dev mode).
 */

async function sendViaTwilio(to: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    console.log(`[SMS/Twilio] Not configured. To: ${to} | Body: ${body}`);
    return;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("[SMS/Twilio] Send failed:", err);
    throw new Error("Failed to send SMS. Please try again.");
  }
}

async function sendViaFast2SMS(to: string, body: string): Promise<void> {
  const apiKey = process.env.FAST2SMS_API_KEY;

  if (!apiKey) {
    console.log(`[SMS/Fast2SMS] Not configured. To: ${to} | Body: ${body}`);
    return;
  }

  // Strip country code for Fast2SMS (expects 10-digit Indian number)
  const mobile = to.replace(/^\+91/, "").replace(/\D/g, "");

  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      route: "q",          // transactional route
      message: body,
      language: "english",
      flash: 0,
      numbers: mobile,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.return === false) {
    console.error("[SMS/Fast2SMS] Send failed:", data);
    throw new Error("Failed to send SMS. Please try again.");
  }
}

export async function sendSms(to: string, body: string): Promise<void> {
  const normalised = to.trim();

  // Indian numbers (+91 or 10-digit starting with 6-9)
  const isIndian =
    normalised.startsWith("+91") ||
    (/^[6-9]\d{9}$/.test(normalised));

  if (isIndian) {
    await sendViaFast2SMS(normalised, body);
  } else {
    await sendViaTwilio(normalised, body);
  }
}
