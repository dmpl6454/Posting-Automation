import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? "587"),
    secure: process.env.SMTP_SECURE === "true", // true = port 465, false = STARTTLS on 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

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
  const from = process.env.SMTP_FROM ?? "PostAutomation <noreply@postautomation.co.in>";

  if (!transport) {
    // Dev fallback — log to console when SMTP is not configured
    console.log("\n[Email Preview — SMTP not configured]");
    console.log(`To:      ${options.to}`);
    console.log(`From:    ${from}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`Body:\n${options.text ?? options.html}\n`);
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
