import fetch from "node-fetch";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const allowedOrigins = new Set([
  "https://oakleyspirits.webflow.io",
  "https://www.oakleyspirits.com",
  "http://localhost:3000",
]);

const allowedHostnames = new Set([
  "oakleyspirits.webflow.io",
  "www.oakleyspirits.com",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function handleSubscribe(
  req: VercelRequest,
  res: VercelResponse,
  fetcher: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (typeof origin === "string" && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const body: unknown = req.body;
  if (!isRecord(body)) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({ message: "Invalid email" });
  }

  const turnstileToken = body.turnstileToken;
  if (
    typeof turnstileToken !== "string" ||
    !turnstileToken ||
    turnstileToken.length > 2048
  ) {
    return res
      .status(400)
      .json({ message: "Missing or invalid security token" });
  }

  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  const apiKey = env.MAILCHIMP_API_KEY;
  const audienceId = env.MAILCHIMP_AUDIENCE_ID;
  const serverPrefix = env.MAILCHIMP_SERVER_PREFIX;

  if (!turnstileSecret || !apiKey || !audienceId || !serverPrefix) {
    console.error("Missing subscribe service configuration");
    return res.status(500).json({ message: "Service unavailable" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let verification: Record<string, unknown>;

  try {
    const response = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          secret: turnstileSecret,
          response: turnstileToken,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Siteverify returned ${response.status}`);
    }

    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.success !== "boolean") {
      throw new Error("Invalid Siteverify response");
    }

    verification = value;
  } catch (error) {
    console.error("Turnstile service error:", error);
    return res.status(502).json({ message: "Security service unavailable" });
  } finally {
    clearTimeout(timeout);
  }

  if (
    !verification.success ||
    typeof verification.hostname !== "string" ||
    !allowedHostnames.has(verification.hostname)
  ) {
    return res.status(403).json({ message: "Bot check failed" });
  }

  const url = `https://${serverPrefix}.api.mailchimp.com/3.0/lists/${audienceId}/members`;
  const data = {
    email_address: email,
    status: "subscribed",
    tags: ["Newsletter"],
  };

  const mailchimpController = new AbortController();
  const mailchimpTimeout = setTimeout(() => mailchimpController.abort(), 8_000);

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: mailchimpController.signal,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const value: unknown = await response.json().catch(() => null);
      const error = isRecord(value) ? value : {};
      return res.status(response.status >= 400 ? response.status : 502).json({
        message: "Mailchimp error",
        error: {
          title:
            typeof error.title === "string" ? error.title : "Mailchimp error",
          detail:
            typeof error.detail === "string"
              ? error.detail
              : "Unable to subscribe. Please try again.",
        },
      });
    }

    return res.status(200).json({ message: "Success" });
  } catch (error) {
    console.error("Mailchimp service error:", error);
    return res.status(502).json({ message: "Mailchimp service unavailable" });
  } finally {
    clearTimeout(mailchimpTimeout);
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleSubscribe(req, res);
}
