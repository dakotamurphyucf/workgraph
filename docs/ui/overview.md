# Overview and Activity

Open **Manage project** (or **Manage workspace** in the workspace-wide view) for
project, milestone and workspace tools. Choose **Maintenance** inside that dialog
for export, restore and recovery. These panels load on demand.

Overview answers three questions: what needs attention, what can proceed, and
what changed. Its reads use the selected connection generation, workspace,
project, actor and run. Actor selection is cooperative attribution, not a login.
Opening either screen never acknowledges a notification or changes ownership.

## Read the counts

The workspace's Projects and Tickets counters include archived records. Active
status totals and graph readiness exclude archived scopes by default, so they do
not add up to the all-record ticket counter. Claimed work is filtered by the
selected actor and run; it is not the same as tickets whose status is In progress.

Project progress counters cover the native selected project. Its project-linked
question counter includes all request statuses on project boards and explicitly
linked threads. The separate unanswered-request count uses the native current
attention selection. Neither count means unread notifications.

Lists beneath counters are bounded excerpts. A remaining count describes omitted
whole records, not a zero result. Readiness is a separate current snapshot:
graph readiness and run admission have different checks. Dependency, allocation,
review and ownership explanations retain their native source links. A reported
usage row names its reporting actor and literal reported quantities; it is not a
measurement of provider spending. Recorded run observations are advisory and do
not establish whether an agent process is alive.

## Observe changes deliberately

Refresh Overview captures its durable change position before reading the current
summaries. In **Notification settings**, use **Load more changes** to consume the remaining
captured change pages.
More ready work pages the independent current eligibility snapshot and does not
advance the durable change position past unseen events.

**Check for changes** in **Notification settings** starts one foreground wait of
at most 25 seconds, after all captured change pages have been consumed. Use
**Stop** or close the settings to cancel it. This deliberate check is separate
from the shared live refresh of visible current data; it does not create its own
background polling loop or retry automatically. A retained
previous result is labelled after cancellation or failure. Clock-based eligibility
can change without a durable event; refresh current readiness explicitly.

Received notifications are optional. Select an explicit actor or run recipient
and apply the selection to start a new capture. This observer uses its own consumer
and never acknowledges notifications. Changing only the displayed screen does
not consume another change page.

## Follow captured activity

The Activity page reads native `activity.since` audit records. Each compact row
shows the actor who made the change, a description, and the event time in your
browser's local time zone. Date headings separate days. Hover over a time or
expand Details to see the complete timestamp and planning revision. Attribution
comes from the audit record, never from the ticket's current assignee.

The page opens on the newest 25 recorded events, then updates automatically.
Refreshes preserve expanded Details and the position of the entry you are reading.
Opened records and the page you started reading stay visible even after they leave
the latest 25; closing all details releases that retained page. Switching filters, scope or captured pages clears that
local retention. The live page continues receiving new activity above them.
**Earlier activity** and **Newer activity** navigate within one captured revision;
**Return to live activity** starts a fresh capture. Earlier pages stay fixed while
you inspect them. A filter may select an actor or ticket; a ticket filter replaces
the project selection and searches that ticket within the workspace. Changing
filters starts a new capture.

A recorded event can contain several changes. The row summarizes its first change;
Details states the full change count and exposes the complete retained audit JSON.
A ticket snapshot is described as an update, not an inferred status or assignment
transition. Unknown change kinds remain inspectable. Missing or invalid times are
explicitly unavailable. Oversized records and read failures produce visible errors;
they are not silently skipped or represented as an empty history.

Ticket and participant links open the current item at the captured endpoint;
comment revision links select the exact retained comment. These links do not
reconstruct historical planning state. Raw records preserve unsupported details.
The Overview's recent-activity section continues to use its bounded semantic
digest; its capture and omissions are independent of the Activity audit feed.

Use the ordinary Work and Discussions surfaces for deliberate edits. The
[recovery guide](recovery.md) describes saved write operations separately from
these passive reads.
