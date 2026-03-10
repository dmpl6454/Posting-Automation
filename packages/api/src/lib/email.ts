// Nodemailer is optional — only loaded if SMTP is configured
let transporter: any = null;

function getTransporter(): any {
  if (!transporter) {
    if (!process.env.SMTP_HOST) {
      console.warn("[Email] No SMTP_HOST configured, emails will be logged to console");
      return null;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodemailer = require("nodemailer");
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    } catch {
      console.warn("[Email] nodemailer not installed, emails will be logged to console");
      return null;
    }
  }
  return transporter;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const transport = getTransporter();
  const from = process.env.SMTP_FROM || "PostAutomation <noreply@postautomation.app>";

  if (!transport) {
    // Dev fallback — log to console
    console.log("\n[Email Preview]");
    console.log(`To: ${options.to}`);
    console.log(`From: ${from}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`Body:\n${options.text || options.html}\n`);
    return true;
  }

  try {
    await transport.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    return true;
  } catch (error) {
    console.error("[Email] Failed to send:", error);
    return false;
  }
}
