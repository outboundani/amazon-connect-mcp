// Operator context - surfaced to connected AI models via the MCP `instructions`
// field on initialize and the `about` tool. Edit freely; this is the place to
// tell the AI who runs this server and how it should behave.

export const ABOUT = `## About this server

amazon-connect-mcp connects AI models to an Amazon Connect instance through
the Amazon Connect API. Its purpose is to **build**: hours of operation,
queues, routing profiles, and real IVR flows compiled from a plain spec,
diagrammed in chat, validated by Connect's own flow validator, and then
**proven with Connect's native testing and simulation** (a simulated call
that presses digits and checks where it lands).

**Operator:** Ryan Shatzkamer ([linkedin.com/in/ryanshatzkamer](https://www.linkedin.com/in/ryanshatzkamer)) -
Director, Technical Services at **outboundIQ**, best-selling author, contact
center architect (80+ platform deployments), and creator of
[five9-mcp](https://github.com/outboundani/five9-mcp),
[genesys-mcp](https://github.com/outboundani/genesys-mcp), and
[cxone-mcp](https://github.com/outboundani/cxone-mcp). This is the fifth
platform in the family, built alongside twilio-mcp: both speak the same IVR
spec, so a Twilio Studio IVR exported with export_ivr_spec builds here with
build_flow, unchanged.

**Why this exists:** Amazon Connect has a deep API and a JSON flow language,
but no MCP server that builds with it and proves the result. By design this
server ships NO deletes, NO go-live wiring, NO dialing, and NO number
inventory changes. A human presses go.

## Amazon Connect vocabulary (get this right)

- A **FLOW** (contact flow) is the IVR. Type CONTACT_FLOW is the inbound
  entry flow a phone number points at. Flows are JSON ("Flow language").
- A **QUEUE** holds callers until an agent is free. Every queue has
  **HOURS OF OPERATION** (a time zone plus open windows per day).
- A **ROUTING PROFILE** is the agent side: which queues an agent takes
  contacts from (priority, delay) and how many at once per channel.
- A **PHONE NUMBER** is claimed into the instance and wired to a flow.
  That wiring is the go-live moment, and it is never done here.

## How to behave

- Reads are always safe. **Confirm with the user before any write** (tools
  badged WRITE), restating exactly what will be created.
- **Create-only bias.** There are no delete tools; creates return an
  existing object with the same name instead of overwriting it. build_flow
  overwrites a flow only with replace: true, and refuses even then if any
  phone number points at the flow.
- In the operator's sandbox, prefix test artifacts with MCP_Test_.
- Tools accept NAMES and resolve ids for you. READ tools accept partial
  names; WRITE tools require the exact name or id and suggest near matches
  when you miss: relay them and ask rather than guessing.
- When the user asks for a build without every detail (prompt wording,
  queue names, hours), choose clean professional values and present them in
  the plan and diagram: one approval pass, not a round of questions.
- **Approval means go**: once the user approves the plan, run the whole
  chain without re-asking at each step.
- If tools fail with AccessDenied, run check_connection: the IAM policy may
  be missing an action (see docs/iam-policy.json), or the key may be
  temporary and expired.

## The build playbook (IVR from a spec, or a migration from Twilio)

1. contact_center_overview FIRST: reuse hours, queues, and routing
   profiles that already exist.
2. render_flow with the spec: show the Mermaid diagram and the declared
   gaps (voicemail!). Get ONE approval for the whole plan.
3. Build in order: create_hours_of_operation (from spec.hours, named
   "<flow name> Hours" unless the user picks a name) -> create_queue for
   each queue (with those hours) -> create_routing_profile (the queues, voice
   concurrency 1) -> build_flow(spec).
4. Prove it: run_flow_test with a digit path per branch the user cares
   about (e.g. ["1"], ["2","1"], ["2","2"], ["3"]). Report Connect's own
   verdict and the transcript.
5. STOP. Going live (pointing a phone number at the flow) is a human step.
   If asked, run go_live_checklist and explain the console steps. Say
   plainly that this server will not do it, on purpose.

Migrating from twilio-mcp: export_ivr_spec on the Twilio side gives the
same spec shape; build_flow takes it as-is. Twilio has no native hours
resource, so hours usually arrive as a gap there and become a real Connect
hours of operation here (an upgrade).

## Spec gaps (declare these before building, never hide them)

- **voicemail**: Amazon Connect has NO native voicemail block (verified:
  no Flow language action records a caller message to a mailbox). build_flow
  compiles voicemail as "play the preceding message, then hang up", marks
  the branch in the flow metadata, and reports the gap. Real voicemail on
  Connect means Voicemail Express (an AWS open-source add-on) or a media
  streaming + Lambda design. Say so on camera.
- **language**: mapped to an Amazon Polly neural voice (en-US = Joanna,
  en-GB = Amy, es-US = Lupe, ...); unmapped languages keep the instance
  default voice and are reported.
- Everything else in the spec (greeting, hours with closed handling, menus
  3 levels deep, previous_menu, transfer_to_queue with a message,
  play_message, no_input retries, hangup) compiles natively.

## API landmines (verified live against a real instance; trust these over the docs)

- **Only PUBLISHED triggers server-side flow validation.** build_flow
  creates flows as PUBLISHED (inert without a phone number) so Connect's
  validator runs, and checks structure locally first.
- **InvalidContactFlowException puts its details in a lower-case
  "problems" array** in the response body; the message field is empty
  (the AWS CLI prints a blank error). build_flow relays problems verbatim,
  e.g. "Action is missing required error. Error: NoMatchingCondition,
  Path: Actions[1]".
- **GetParticipantInput must declare three errors**: NoMatchingError,
  NoMatchingCondition, and InputTimeLimitExceeded, or validation fails.
  DTMF branches are Conditions with Operator Equals and the digit as the
  single operand.
- **Routing to a queue is two actions**: UpdateContactTargetQueue (QueueId
  = the queue ARN) then TransferContactToQueue (no parameters; handles
  QueueAtCapacity and NoMatchingError).
- **Action Identifiers**: max 50 characters, and none of % : ( \\ / ) = $ ,
  ; [ ] { }. Friendly names are allowed.
- **Flow Metadata is stored verbatim**, so this server keeps option labels
  and the voicemail gap marker there, and export_flow_spec round-trips them.
- **Always-open hours are encoded as 00:00 to 00:00** on every day (the
  default "Basic Hours"). The spec's "24:00" maps to that.
- **AssociatePhoneNumberContactFlow is not the only go-live door**:
  AssociateFlow (PUT /flow-associations) can also wire a number to a flow.
  Both are refused in code and denied in docs/iam-policy.json.
- **Instance auto-discovery needs exactly one instance.** With two or more
  in the region, set CONNECT_INSTANCE_ID; the error lists them.
- **Native test cases need no phone number**: a VOICE_CALL entry point
  with only a FlowId simulates a contact (a real ContactId, nothing
  dials). A four-step path took about 26 seconds to PASS.
- **Test prompts come back as speech transcripts**: the simulator heard
  "For sales, press one" for the TTS text "press 1", so run_flow_test
  matches prompts by Similarity, not Inclusion.
- **FlowActionStarted events must name the queue** (omitting
  ActionParameters.QueueId is InvalidFlowActionParametersProblem), and a
  test that waits for an event that never happens fails only after about
  5 minutes ("Test case execution exceeded time limit", OBSERVE_EVENT). So
  run_flow_test watches the transfer the flow actually makes and ASSERTS
  the expected queue name: a wrong queue fails in about 25 seconds with
  the real queue named (an Assert's ActualParameters.Namespace carries the
  resolved value, not the JSONPath).
- **InvalidTestCaseException details live in "problemDetails"** (the API
  reference says Problems), e.g. "InvalidFlowActionParametersProblem{...}".
- **The summary and the records can disagree**: a run failed by an
  assertion reported ObservationsFailed 1 in the summary while the
  COMPLETION record's ExecutionSummary said FailedObservations 0 (with
  FailureReasons ASSERT_DATA). run_flow_test reports the summary verdict.
- **The test-case IAM actions are not in the IAM catalog yet**: IAM Access
  Analyzer flags connect:CreateTestCase and the six related actions as
  "does not exist" (checked 2026-09-29). docs/iam-policy.json lists them
  anyway, by their API names; if your org blocks policies with findings,
  drop that statement and run_flow_test will be denied.
- **StartTestCaseExecution returns TestCaseId as the full ARN**, not the
  id the create call returned; execution records are JSON strings with a
  RecordType (INITIATION, EXECUTION_START, OBSERVATION, COMPLETION) the
  API reference does not list.
- **Outbound campaigns need instance onboarding first.** On a fresh
  instance, CreateCampaign answers "Connect Instance does not exist or is
  not enabled to use Campaigns". Campaign creation is v0.2; outbound_readiness
  reports the state today.
- ListFlowAssociations takes its filter as a PascalCase query key
  (ResourceType=VOICE_PHONE_NUMBER) while every other list API uses
  camelCase (nextToken, maxResults). Pagination tokens come back as null,
  not absent.

## Raw tool rails (connect_api_call)

Reads and the typed tools' creates only, on an allowlist of operation
templates, after normalizing the path (no %, ;, \\, #, ?, whitespace, empty
or dot segments; ids, not ARNs). The host is pinned to
connect.<region>.amazonaws.com or connect-campaigns.<region>.amazonaws.com.
A refusal is final: do not rephrase the path to get around it. The same
allowlist runs inside the client for EVERY request, typed tools included.`;

// Short version for the MCP initialize handshake.
export const INSTRUCTIONS = `MCP server for Amazon Connect, operated by Ryan Shatzkamer (Director, Technical Services at outboundIQ; creator of five9-mcp, genesys-mcp, and cxone-mcp). Its purpose is BUILDING: hours of operation, queues, routing profiles, and IVR flows compiled from the shared IVR spec (the same spec twilio-mcp exports), diagrammed in chat, validated by Connect's own flow validator, and PROVEN with Connect's native test cases (a simulated call that presses digits and checks the queue it lands in). Call the "about" tool for the vocabulary, the build playbook, the spec gaps (voicemail has no native Connect block), and the verified API landmines. Reads are safe; confirm before WRITE tools; it never deletes. Nothing it builds goes live: no tool points a phone number at a flow, dials, or starts a campaign - a human presses go.`;
