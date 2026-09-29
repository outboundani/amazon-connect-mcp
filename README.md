# amazon-connect-mcp

**Your Amazon Connect instance, in your AI's hands.** An open-source MCP server for Amazon Connect on Cloudflare Workers. Zero dependencies (SigV4 is hand-rolled on Web Crypto), no terminal required, and its whole purpose is to **build**: hours of operation, queues, routing profiles, and **real IVR flows** compiled from a plain spec, diagrammed in chat before deploy, validated by Connect's own flow validator, and then **proven with a simulated call** using Connect's native testing and simulation.

> It builds, it proves, and it never goes live on its own.

Prompt Claude (or any MCP client):

- *"give me the contact center overview"*
- *"build a main line IVR: greeting, press 1 for sales, 2 for a support menu with new issue, existing ticket, and a way back, 3 for billing. weekdays 8 to 6 eastern. show me the diagram first"*
- *"now prove it: simulate a caller pressing 2 then 1 and tell me where they land"*
- *"export the Main_Line flow back to the IVR spec"*
- *"draw the Sample inbound flow as a diagram"*
- *"point our main number at it"* (refused, politely, with a pre-flight checklist: a human presses go)

## Built with twilio-mcp: one IVR spec, two platforms

amazon-connect-mcp and [twilio-mcp](https://github.com/outboundani/twilio-mcp) speak the **same IVR spec**. `export_ivr_spec` on Twilio gives you JSON that `build_flow` here takes unchanged, so a migration is literally: export from Twilio, build on Connect, prove it with a test call.

```json
{
  "name": "Main_Line",
  "language": "en-US",
  "greeting": "Thanks for calling Acme Home Services.",
  "hours": {
    "timezone": "America/New_York",
    "schedule": [{ "days": ["monday","tuesday","wednesday","thursday","friday"], "start": "08:00", "end": "18:00" }],
    "closed": { "message": "We're closed right now.", "then": { "type": "voicemail", "message": "Leave a message after the tone." } }
  },
  "menu": {
    "prompt": "For sales, press 1. For support, press 2. For billing, press 3.",
    "options": [
      { "digit": "1", "label": "Sales",   "action": { "type": "transfer_to_queue", "queue": "Sales", "message": "Connecting you to sales." } },
      { "digit": "2", "label": "Support", "action": { "type": "submenu", "menu": {
          "prompt": "For a new issue, press 1. For an existing ticket, press 2. To go back, press 9.",
          "options": [
            { "digit": "1", "action": { "type": "transfer_to_queue", "queue": "Support" } },
            { "digit": "2", "action": { "type": "transfer_to_queue", "queue": "Support_Escalations" } },
            { "digit": "9", "action": { "type": "previous_menu" } }
          ] } } },
      { "digit": "3", "label": "Billing", "action": { "type": "transfer_to_queue", "queue": "Billing" } }
    ],
    "no_input": { "retries": 2, "message": "Sorry, I didn't catch that.", "then": { "type": "hangup" } }
  }
}
```

Actions: `transfer_to_queue` (optional `message`), `submenu`, `previous_menu`, `play_message` (optional `then`), `voicemail`, `hangup`. Menus nest three levels deep.

**What Connect cannot express natively, declared up front:** `voicemail`. Amazon Connect has no native voicemail block, so `build_flow` plays the preceding message, hangs up, marks the branch, and reports the gap every time (the fix is Voicemail Express or a media streaming design). Everything else, including hours with a closed branch, compiles natively; Connect's hours of operation are a real resource, which is an upgrade over platforms that fake hours in the flow.

## What it deliberately does NOT do

- **No go-live.** No tool points a phone number at a flow. `AssociatePhoneNumberContactFlow` and `AssociateFlow` (the second door most people miss) are refused in code, and `build_flow` will not even replace a flow's content if a number points at it. Built flows are PUBLISHED but inert until a human wires a number in the Connect console.
- **No dialing.** No `StartOutboundVoiceContact`, no `Start*Contact`, no campaign start or resume. Native test calls are simulated contacts: nothing dials.
- **No deletes.** There are no delete tools, and the client refuses every DELETE. Creates return an existing object with the same name instead of overwriting it.
- **No number inventory changes.** Phone numbers are read only (no claim, release, import, or retarget).
- **No IAM or security profile writes.** Users are read only.

These are not just tool choices. The same allowlist runs inside the API client on **every** request, typed tools included, and [`docs/iam-policy.json`](docs/iam-policy.json) makes AWS enforce the promise too: a least-privilege allow for exactly what the tools do, plus explicit **Deny** for `connect:Delete*`, `connect:Disassociate*`, `connect:AssociatePhoneNumberContactFlow`, `connect:AssociateFlow`, `connect:UpdatePhoneNumber`, `connect:ClaimPhoneNumber`, `connect:ReleasePhoneNumber`, `connect:StartOutboundVoiceContact` (and every other contact start), `connect-campaigns:Start*`, `connect-campaigns:Resume*`, user and security profile writes, and `iam:*`.

## Deploy your own in 3 steps

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/outboundani/amazon-connect-mcp)

1. **Deploy**: click the button (free Cloudflare account), or `git clone` + `npx wrangler deploy`. The CONFIG KV namespace is auto-provisioned.
2. **Create a least-privilege IAM key**: in IAM, create a dedicated user, attach `docs/iam-policy.json` as an inline or managed policy, and create an access key for it.
3. **Configure**: open `/setup` on your new Worker and paste the access key ID, secret, and region. The wizard tests them live against Amazon Connect before saving, finds your instance automatically if the region has exactly one (otherwise paste the instance ID), then hands you your access key for MCP clients (shown once).

Prefer terminal-managed config? Set Wrangler secrets instead; they override the wizard: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `MCP_AUTH_TOKEN`, and optionally `CONNECT_INSTANCE_ID` (and `AWS_SESSION_TOKEN` for temporary credentials, which expire).

## Connect your AI

The MCP endpoint is `https://<your-worker>/mcp`.

- **Claude (web/desktop)**: Settings → Connectors → Add custom connector → paste the URL. When the authorization screen appears, paste your access key.
- **Claude Code**: `claude mcp add --transport http amazon-connect https://<your-worker>/mcp` and authenticate when prompted.
- **ChatGPT**: Settings → Connectors → Advanced → Developer mode → add the MCP server URL.
- **Anything else**: standard streamable HTTP MCP with OAuth 2.1 (or send the access key as a Bearer token).

Then try: *"check the connection and give me the contact center overview."*

## The toolbox (27 tools)

| Group | Tools |
|---|---|
| 🔌 Instance & Connection | `about`, `check_connection`, `list_instances`, `contact_center_overview` |
| 🏗️ Flows (IVR Builder) | `list_contact_flows`, `get_contact_flow`, `render_flow`, `build_flow` ✏️, `export_flow_spec` |
| 🧪 Native Testing | `run_flow_test` ✏️, `get_test_run`, `go_live_checklist` |
| 🕐 Hours & Queues | `list_hours_of_operation`, `get_hours_of_operation`, `create_hours_of_operation` ✏️, `list_queues`, `get_queue`, `create_queue` ✏️ |
| 👥 Routing & People | `list_routing_profiles`, `get_routing_profile`, `create_routing_profile` ✏️, `list_users`, `get_user` |
| 📇 Numbers, Prompts & Outbound | `list_phone_numbers`, `list_prompts`, `outbound_readiness` |
| ⚡ Power | `connect_api_call` ✏️ (reads plus the typed tools' creates, on an allowlist; refuses deletes, go-live, dialing, number changes, and identity writes; redacts secrets) |

✏️ = writes to your instance. `run_flow_test` writes a test case (a receipt), never a contact to a real phone. Reads are always safe; connected AIs are instructed to confirm before every write.

## Amazon Connect vocabulary (worth 30 seconds)

- A **flow** (contact flow) is the IVR, stored as JSON in the Flow language. Type `CONTACT_FLOW` is the one a phone number points at.
- A **queue** holds callers until an agent is free, and every queue has **hours of operation**.
- A **routing profile** is the agent side: which queues an agent takes calls from, in what priority, and how many contacts at once per channel.
- A **phone number** is claimed into the instance and wired to a flow. That wiring is the go-live moment, and it belongs to a human.

## For the nerds

- **Zero dependencies.** Not one npm package. SigV4 is hand-rolled on Web Crypto and checked against **AWS's published SigV4 test suite** (13 vectors, including query ordering, UTF-8 query keys, header value trimming, and session tokens signed before and after), so a canonicalization bug shows up as a failed unit test, not a 403.
- **A real compiler, not a template.** `build_flow` compiles the spec to Flow language JSON: `MessageParticipant` greetings, `GetParticipantInput` DTMF menus with retries unrolled, `UpdateContactTargetQueue` + `TransferContactToQueue` transfers, `CheckHoursOfOperation` branching, `UpdateContactTextToSpeechVoice` for the language, and a laid-out canvas so the flow opens cleanly in the Connect designer. It passed Connect's server-side validator on the first live try.
- **Round trip.** `export_flow_spec` reads any flow back into the spec (labels and gap markers ride along in the flow's Metadata, which Connect stores verbatim), and the unit tests prove compile then export returns the original spec. Flows this server did not build still export, with every unsupported action named instead of dropped.
- **Proof, not vibes.** `run_flow_test` writes a Connect test case in the Testing language: hear the greeting, hear the menu, press 2, hear the submenu, press 1, watch the transfer, assert the queue name. Connect runs it against a simulated contact and returns the verdict. If the flow checks hours, the test substitutes an always-open hours resource so the result does not depend on the clock.
- **Normalize-then-allowlist.** Paths are refused before matching if they carry `%`, `;`, `\`, `#`, `?`, whitespace, or empty/dot segments; query keys must be unique identifiers; the host is built from the service name and a validated region, never from input. Then only allowlisted operation templates pass. The raw tool and the typed tools share the guard.
- **OAuth 2.1 built in** (dynamic client registration, PKCE, stateless HMAC-signed tokens), so it plugs straight into Claude and ChatGPT as a connector.
- **The docs drift; the tools encode reality.** Verified live and baked in:
  - Only a PUBLISHED flow triggers server-side validation, and `InvalidContactFlowException` puts its details in a lower-case `problems` array with an empty message (the AWS CLI prints a blank error). `build_flow` relays the problems verbatim.
  - `GetParticipantInput` must declare `NoMatchingError`, `NoMatchingCondition`, and `InputTimeLimitExceeded`, or validation fails.
  - Action identifiers max out at 50 characters and ban `% : ( \ / ) = $ , ; [ ] { }`.
  - Always-open hours are `00:00` to `00:00` on every day.
  - Native test cases need no phone number: a flow id is enough. Prompts come back as speech transcripts ("press one" for "press 1"), so matching is by similarity. `StartTestCaseExecution` returns the test case id as a full ARN. `InvalidTestCaseException` details live in `problemDetails`, not `Problems`. A `FlowActionStarted` event must name the queue. A test waiting for an event that never comes fails only after about 5 minutes, so the queue check is an assertion that fails in about 25 seconds and names the real queue. The run summary and the completion record can disagree on the failed-observation count.
  - The test-case IAM actions are not in the IAM catalog yet: Access Analyzer calls `connect:CreateTestCase` "does not exist" (checked 2026-09-29). The shipped policy lists them by their API names anyway.
  - Outbound campaigns need the instance onboarded first; on a fresh instance `CreateCampaign` answers "Connect Instance does not exist or is not enabled to use Campaigns". Campaign creation is v0.2.
- Tested against a live Amazon Connect instance: 62 unit tests plus a 43-step live smoke suite (`npm test`, `npm run smoke`; read-only by default, `-- --writes` builds `MCP_Test_`-prefixed hours, queues, a routing profile, and the Main_Line flow, then runs four native test calls, including one that must fail).

## Roadmap

- **v0.2**: `create_outbound_campaign` (outbound campaigns v2, created without a schedule and never started), Lex bot menus, prompts from audio files, and stopping a runaway test run.

## License

MIT. Built by [Ryan Shatzkamer](https://www.linkedin.com/in/ryanshatzkamer) (Director, Technical Services @ [outboundIQ](https://outboundiq.com)), creator of [five9-mcp](https://github.com/outboundani/five9-mcp), [genesys-mcp](https://github.com/outboundani/genesys-mcp), and [cxone-mcp](https://github.com/outboundani/cxone-mcp). This is platform number five, launched alongside twilio-mcp.
