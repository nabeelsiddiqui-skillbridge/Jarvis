import nodemailer from "nodemailer";

/**
 * Outbound email (briefings, reports, alerts). Optional: without SMTP_URL the
 * platform delivers in-app notifications only and says so wherever email is offered.
 */
const url = () => process.env.SMTP_URL?.trim();
export const emailConfigured = () => Boolean(url());

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function sendEmail(m: { to: string[]; subject: string; text: string; html?: string }) {
  if (!emailConfigured()) throw new Error("Email delivery isn't configured (SMTP_URL).");
  transport ??= nodemailer.createTransport(url()!);
  await transport.sendMail({ from: process.env.EMAIL_FROM ?? "Business Command AI <no-reply@localhost>", to: m.to, subject: m.subject, text: m.text, html: m.html });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
