import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startHarness } from "./harness.ts";

// The server runs at http://203.0.113.7:3000 (an IP-based server), but the GitHub App was created
// while PUBLIC_URL was still the localhost default.
const h = await startHarness(
  { "agents/coder/agent.md": "---\nhandle: aorch-coder\ndescription: coder\n---\nYou are coder.\n" },
  { PUBLIC_URL: "http://203.0.113.7:3000", AUTH_DISABLED: "false", ADMIN_TOKEN: "test-admin-token", ADMIN_USERS: "alice", GITHUB_CLIENT_ID: "Iv1.test", GITHUB_CLIENT_SECRET: "secret" },
);
after(() => h.stop());
const { app, fake } = h;
const admin = { authorization: "Bearer test-admin-token" };

test("a GitHub App created for another PUBLIC_URL is caught before sign-in fails on GitHub, and its webhook URL can be fixed", async () => {
  const me = (await app.inject({ method: "GET", url: "/api/auth/me" })).json();
  assert.equal(me.login, null);
  assert.equal(me.callbackUrl, "http://203.0.113.7:3000/api/auth/github/callback");
  assert.match(me.signInProblem, /The GitHub App was set up for http:\/\/localhost:3000 \(its Homepage URL\), but PUBLIC_URL is http:\/\/203\.0\.113\.7:3000/);
  assert.match(me.signInProblem, /set the Callback URL to http:\/\/203\.0\.113\.7:3000\/api\/auth\/github\/callback/);

  // The sign-in redirect uses PUBLIC_URL, which is why GitHub rejects it while the App still has the old Callback URL.
  const redirect = await app.inject({ method: "GET", url: "/api/auth/github" });
  assert.equal(new URL(redirect.headers.location as string).searchParams.get("redirect_uri"), "http://203.0.113.7:3000/api/auth/github/callback");

  const setup = (await app.inject({ method: "GET", url: "/api/setup", headers: admin })).json();
  assert.match(setup.callbackProblem, /redirect_uri is not associated/);
  assert.match(setup.webhookProblem, /GitHub sends this App's webhooks to http:\/\/localhost:3000\/api\/github\/webhooks, not to http:\/\/203\.0\.113\.7:3000\/api\/github\/webhooks/);
  assert.equal(setup.appAddresses.settingsUrl, `${fake.url}/organizations/acme/settings/apps/test-orchestrator`);

  const fixed = (await app.inject({ method: "POST", url: "/api/setup/webhook-url", headers: admin })).json();
  assert.equal(fake.appWebhookUrl, "http://203.0.113.7:3000/api/github/webhooks");
  assert.equal(fixed.webhookProblem, null);
  assert.ok(fixed.callbackProblem, "the Callback URL can only be changed on GitHub");

  // Once the App's Homepage (and Callback) URL is updated on GitHub, the notice goes away.
  fake.appHomepage = "http://203.0.113.7:3000/";
  const after = (await app.inject({ method: "POST", url: "/api/setup/webhook-url", headers: admin })).json(); // re-reads the App's settings
  assert.equal(after.callbackProblem, null);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me" })).json().signInProblem, null);
});

/** Goes through GitHub sign-in as the browser would: start, then come back with GitHub's code. */
async function signIn(query = "code=abc", withCookie = true) {
  const start = await app.inject({ method: "GET", url: "/api/auth/github" });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const cookie = [start.headers["set-cookie"]].flat().find((value) => value?.startsWith("ao_oauth_state="))!.split(";")[0]!;
  const back = await app.inject({ method: "GET", url: `/api/auth/github/callback?${query}&state=${state}`, headers: withCookie ? { cookie } : {} });
  return { location: decodeURIComponent(String(back.headers.location)), cookies: [back.headers["set-cookie"]].flat().join("; ") };
}

test("GitHub sign-in says why it failed instead of hanging", async () => {
  const ok = await signIn();
  assert.equal(ok.location, "/#/");
  assert.match(ok.cookies, /ao_session=/);

  fake.oauthUser = "mallory";
  assert.match((await signIn()).location, /@mallory is not an admin\. Add them to ADMIN_USERS/);
  fake.oauthUser = "alice";

  fake.oauth = "bad_code";
  assert.match((await signIn()).location, /GitHub didn't accept the sign-in: The code passed is incorrect or expired\./);

  // The server can't reach GitHub: a clear reason on the sign-in page, not a bare "fetch failed".
  fake.oauth = "drop";
  const dropped = (await signIn()).location;
  assert.match(dropped, /The orchestrator couldn't reach 127\.0\.0\.1:\d+ to finish signing you in \(.+\)\. Check that this server can make HTTPS requests/);
  fake.oauth = "ok";

  assert.match((await signIn("code=abc", false)).location, /Sign-in expired, or it was started at another address than PUBLIC_URL \(http:\/\/203\.0\.113\.7:3000\)/);
  assert.match((await signIn("error=access_denied&error_description=The+user+has+denied+your+application+access.")).location, /GitHub said: The user has denied your application access\./);
});
