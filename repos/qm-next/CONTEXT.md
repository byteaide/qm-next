# QM Agent Runtime

QM coordinates work entering from interactive and non-interactive sources, admits it safely, executes it as Runs, and exposes trustworthy lifecycle outcomes.

## Language

### Work intake

**Turn**:
A unit of work submitted from any caller and considered only after Admission accepts it.
_Avoid_: request, message, session

**Admission**:
The boundary that validates, authorizes, applies Security Screen, and dispatches a Turn.
_Avoid_: intake, entry point, dependency bag

**Admission Record**:
The durable evidence of an Admission decision, including rejected work that never becomes a Run.
_Avoid_: audit log, rejection event, failed run

**Trigger**:
A declared non-interactive source that starts a Turn.
_Avoid_: cron, webhook, background job

**Intake Key**:
The durable identity of one external delivery used to recognize repeated intake.
_Avoid_: event ID, dedup ID, message ID

**Intake Subscriber**:
An explicit durable consumer of accepted intake work.
_Avoid_: callback, listener, side effect

**Subscriber Cursor**:
A durable position held independently by one Intake Subscriber.
_Avoid_: offset, consumer group, event cursor

**Redaction Marker**:
The observable indication that sensitive content was removed while preserving that redaction occurred.
_Avoid_: mask, placeholder, deleted field

**OAuth Token**:
A credential that authorizes Connector access to an external account and never enters observation or diagnostics.
_Avoid_: access token, refresh token, secret key

**Security Screen**:
An Admission stage that evaluates a Turn for security risk before dispatch.
_Avoid_: screener, moderation, diagnostics

**Shadow Mode**:
Security Screen evaluation that records a Shadow Record without blocking the Turn.
_Avoid_: dry run, monitoring, observability

**Shadow Record**:
The reviewable result of a Security Screen evaluation made in Shadow Mode.
_Avoid_: diagnostic log, trace, sample

**Enforce Mode**:
Security Screen evaluation that may reject a Turn at Admission.
_Avoid_: production mode, hard mode, guardrail

**Admission Waterfall**:
The fixed ordered stages through which a submitted Turn must pass.
_Avoid_: middleware chain, pipeline, filter list

### Run lifecycle

**Run**:
One bounded execution attempt for admitted work, potentially containing multiple Attempts.
_Avoid_: job, execution, task

**Attempt**:
One bounded execution pass within a Run.
_Avoid_: retry, run, execution

**Attempt Failure**:
The end of one Attempt without completing the Run.
_Avoid_: failed run, terminal event, cancel

**Run Outcome**:
The closed terminal result of a Run: succeeded, failed, or cancelled.
_Avoid_: status, result, completion state

**Failure Reason**:
The explanation for a failed Run, including timeout or Command Refusal.
_Avoid_: error, exception, stack trace

**Terminal Event**:
The final Run lifecycle event that irrevocably records the Run Outcome.
_Avoid_: completion event, final state, result callback

**Run Event**:
A typed lifecycle occurrence in a Run's event history; non-terminal events may belong to one Attempt.
_Avoid_: log entry, notification, callback

**Event Cursor**:
A consumer's durable position in one Run's event history.
_Avoid_: offset, timestamp, stream ID

**Run Visibility**:
The authorization relationship that determines who may observe a Run and its events.
_Avoid_: public link, admin access, session ID check

**Awaiting Approval**:
The nonterminal Run state in which work is blocked while awaiting Approval.
_Avoid_: pending approval, done, paused, rejected

**Run State**:
The lifecycle position of a Run: queued, running, awaiting approval, succeeded, failed, or cancelled.
_Avoid_: done, status, result

**Attempt State**:
The lifecycle position of one Attempt: queued, running, suspended, succeeded, failed, or cancelled.
_Avoid_: run state, retry state, result

**Approval Request**:
The durable request for authorization of a policy-gated command.
_Avoid_: approval, confirmation, prompt

**Suspended Attempt**:
An Attempt paused at a safety boundary without success or failure.
_Avoid_: stopped run, done attempt, background attempt

**Approval Continuation**:
The durable link from an Approval Request to the suspended work it may resume.
_Avoid_: follow-up run, retry, callback

**Continuation Attempt**:
A new Attempt in the same Run that resumes a Suspended Attempt.
_Avoid_: successor run, replay, retry

**Session Continuation Reservation**:
The temporary session-level claim that preserves coherence while a Run awaits Approval.
_Avoid_: session lease, lock, executor lease

**Silent Success**:
A Run that succeeded without producing user-visible output.
_Avoid_: silent, empty run, no result

### Safety and integration

**Command Gate**:
The per-command boundary that applies Command Policy immediately before execution.
_Avoid_: sandbox check, command filter, Admission

**Command Request**:
The structured description of a candidate command evaluated by Command Gate.
_Avoid_: command string, tool call, shell input

**Baseline Policy**:
The minimum Command Policy explicitly selected for a deployment.
_Avoid_: default policy, denylist, fallback rule

**Command Policy**:
The rule set used by Command Gate to judge whether a command may execute.
_Avoid_: safety check, permission check, diagnostic

**Command Decision**:
The Command Gate result: allowed, denied, or approval required.
_Avoid_: exit code, error, policy result

**Command Refusal**:
A failed Run caused by Command Gate denying a command.
_Avoid_: refused, rejection, cancellation

**Approval**:
Explicit authorization that releases a Pending Approval command for execution.
_Avoid_: override, exception, bypass

**Runtime Contract**:
The shared behavioral boundary between runtime collaborators, independent of their implementations.
_Avoid_: dependency bag, internal API, service locator

**Trigger Runtime**:
The runtime boundary provided to Triggers for dispatching work without exposing the API implementation.
_Avoid_: cron runtime, API service, scheduler singleton

**Connector OAuth**:
The durable authorization lifecycle that lets a Connector act on an external account.
_Avoid_: login, HTTP callback, token flow

**Side-Effecting Operation**:
An operation that can change durable state, external state, or resources beyond the requester's view.
_Avoid_: write, mutation, dangerous command

**Sensitive Read**:
A read whose exposure requires authorization even though it changes no state.
_Avoid_: read-only operation, safe command, query
