import assert from "node:assert/strict";
import test from "node:test";

import { handleSubscribe } from "../api/subscribe.ts";

const env = {
  TURNSTILE_SECRET_KEY: "test-secret",
  MAILCHIMP_API_KEY: "test-api-key",
  MAILCHIMP_AUDIENCE_ID: "test-audience",
  MAILCHIMP_SERVER_PREFIX: "us1",
};

const validBody = {
  email: " new@example.com ",
  turnstileToken: "valid-token",
};

const verified = {
  status: 200,
  body: { success: true, hostname: "oakleyspirits.webflow.io" },
};

function createResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function invoke({ body = validBody, responses = [], config = env } = {}) {
  const calls = [];
  const result = { statusCode: 200, headers: {}, body: undefined };
  const response = {
    setHeader(name, value) {
      result.headers[name] = value;
      return this;
    },
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(value) {
      result.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected service request");
    if (next instanceof Error) throw next;
    return createResponse(next.status, next.body);
  };

  await handleSubscribe(
    { method: "POST", headers: { origin: "https://oakleyspirits.webflow.io" }, body },
    response,
    fetcher,
    config,
  );

  return { calls, result };
}

test("rejects missing bodies and invalid fields before calling services", async () => {
  for (const body of [
    null,
    { email: "bad-email", turnstileToken: "token" },
    { email: "valid@example.com" },
  ]) {
    const { calls, result } = await invoke({ body });
    assert.equal(result.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});

test("reports missing server configuration without contacting services", async (t) => {
  t.mock.method(console, "error", () => {});
  const { calls, result } = await invoke({
    config: { ...env, MAILCHIMP_API_KEY: undefined },
  });
  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, { message: "Service unavailable" });
  assert.equal(calls.length, 0);
});

test("rejects invalid Turnstile tokens and unapproved hostnames", async () => {
  for (const verification of [
    { success: false },
    { success: true, hostname: "other.example" },
  ]) {
    const { calls, result } = await invoke({
      responses: [{ status: 200, body: verification }],
    });
    assert.equal(result.statusCode, 403);
    assert.deepEqual(result.body, { message: "Bot check failed" });
    assert.equal(calls.length, 1);
  }
});

test("reports Turnstile service and response failures separately", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const serviceResponse of [
    new Error("Service unreachable"),
    { status: 502, body: null },
    { status: 200, body: { unexpected: true } },
  ]) {
    const { calls, result } = await invoke({
      responses: [serviceResponse],
    });
    assert.equal(result.statusCode, 502);
    assert.deepEqual(result.body, { message: "Security service unavailable" });
    assert.equal(calls.length, 1);
  }
});

test("subscribes a new member without returning Mailchimp profile data", async () => {
  const { calls, result } = await invoke({
    body: { ...validBody, collector: true },
    responses: [verified, { status: 200, body: { id: "private-member-id" } }],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { message: "Success" });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email_address: "new@example.com",
    status: "subscribed",
    tags: ["Newsletter"],
  });
});

test("accepts a verified token from the production hostname", async () => {
  const { result } = await invoke({
    responses: [
      { status: 200, body: { success: true, hostname: "www.oakleyspirits.com" } },
      { status: 200, body: {} },
    ],
  });

  assert.equal(result.statusCode, 200);
});

test("preserves the Mailchimp error fields used by the frontend", async () => {
  for (const error of [
    { title: "Member Exists", detail: "Already subscribed" },
    { title: "Forgotten Email Not Subscribed", detail: "Cannot resubscribe" },
  ]) {
    const { result } = await invoke({
      responses: [
        verified,
        { status: 400, body: { ...error, internal: "not for the browser" } },
      ],
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { message: "Mailchimp error", error });
  }
});

test("reports Mailchimp network failures without claiming success", async (t) => {
  t.mock.method(console, "error", () => {});
  const { result } = await invoke({
    responses: [verified, new Error("Service unreachable")],
  });

  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, { message: "Mailchimp service unavailable" });
});
