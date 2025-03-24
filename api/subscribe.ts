import fetch from "node-fetch";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://oakleyspirits.webflow.io"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { email, collector } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ message: "Invalid Email" });
  }

  const API_KEY = process.env.MAILCHIMP_API_KEY;
  const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
  const SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX;

  if (!API_KEY || !AUDIENCE_ID || !SERVER_PREFIX) {
    throw new Error("Missing Mailchimp environment variables");
  }

  const url = `https://${SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${AUDIENCE_ID}/members`;

  const tags = ["Newsletter"];
  if (collector) tags.push("Collector Tier");

  const data = {
    email_address: email,
    status: "subscribed",
    tags,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `apikey ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const responseData = await response.json();

    if (response.status >= 400) {
      return res
        .status(response.status)
        .json({ message: "Mailchimp error", error: responseData });
    }

    return res.status(200).json({ message: "Success", data: responseData });
  } catch (error) {
    console.error("Server Error!", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
