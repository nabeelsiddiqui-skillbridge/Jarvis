import nodemailer from "nodemailer";

/**
 * Outbound email (briefings, reports, alerts). Optional: without SMTP_URL the
 * platform delivers in-app notifications only and says so wherever email is offered.
 */
const url = () => process.env.SMTP_URL?.trim();
export const emailConfigured = () => Boolean(url());

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
let transportUrl: string | undefined;

export async function sendEmail(m: { to: string[]; subject: string; text: string; html?: string }) {
  if (!emailConfigured()) throw new Error("Email delivery isn't configured (SMTP_URL).");
  // Rebuilt when the SMTP URL changes (it can be set in Admin → Credentials).
  if (!transport || transportUrl !== url()) { transportUrl = url(); transport = nodemailer.createTransport(transportUrl!); }
  await transport.sendMail({ from: process.env.EMAIL_FROM ?? "Business Command AI <no-reply@localhost>", to: m.to, subject: m.subject, text: m.text, html: m.html });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
