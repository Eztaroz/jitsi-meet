# Issue tracker: the hospital's GitLab

Issues, specs and merge requests for this repo live on the hospital's own GitLab, which is the primary home of the code. GitHub (`Eztaroz/jitsi-meet`) is a public mirror for work away from the hospital (a fork of a public repo cannot be private), and it keeps the issues opened before the move.

## This repo

- **Where:** the GitLab host and project are not written in the repo. Read them from the environment: `GITLAB_URL` (for example `https://gitlab.example.org`) and `GITLAB_PROJECT` (the project path, URL-encoded, for example `group%2Fjitsi-meet`). The token is `GITLAB_TOKEN`, a personal access token with the `api` scope. If any of them is missing, ask the user for it; never write it to a file in the repo or to memory.
- **Old GitLab:** this GitLab predates 11.0. There is no `glab`, no sub-issues, no issue dependencies and no `add_labels`. Use the REST API (v4) with `curl` from the Bash tool, as below.
- **Older issues:** the issues opened before the move stay on GitHub, as history. Cite them as `GitHub #14`, and read them with `gh issue view 14 --repo Eztaroz/jitsi-meet`. A bare `#14` means a GitLab issue.
- **What goes in an issue:** never patient data or credentials.

Every call below uses:

```sh
API="$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT"
AUTH="PRIVATE-TOKEN: $GITLAB_TOKEN"
```

## Conventions

- **Create an issue**: `curl -sS -H "$AUTH" -X POST "$API/issues" --data-urlencode "title=..." --data-urlencode "description@body.md" --data-urlencode "labels=needs-triage"`. Write a multi-line body to a file in the scratchpad first.
- **Read an issue**: `curl -sS -H "$AUTH" "$API/issues/<iid>"`, then its comments with `curl -sS -H "$AUTH" "$API/issues/<iid>/notes?sort=asc"`. `<iid>` is the `#number` shown in GitLab.
- **List issues**: `curl -sS -H "$AUTH" "$API/issues?state=opened&labels=<a>,<b>&per_page=100"`. GitLab's states are `opened` and `closed`.
- **Comment on an issue**: `curl -sS -H "$AUTH" -X POST "$API/issues/<iid>/notes" --data-urlencode "body@comment.md"`.
- **Apply / remove labels**: this GitLab replaces the whole list. Read the issue's `labels`, change the list, then `curl -sS -H "$AUTH" -X PUT "$API/issues/<iid>" --data-urlencode "labels=<a>,<b>"`.
- **Close**: post the explanation as a comment, then `curl -sS -H "$AUTH" -X PUT "$API/issues/<iid>" -d state_event=close`.
- **Make an issue part of a parent**: put `Part of #<parent>` at the top of the child's body, and add `- [ ] #<child>` to a task list in the parent's body.
- **Blocking**: put a `Blocked by: #<n>, #<n>` line at the top of the child's body. A ticket is unblocked when every issue on that line is closed: read each one and check that its `state` is `closed`.
- **Labels the first time**: if a triage label does not exist yet, create it with `curl -sS -H "$AUTH" -X POST "$API/labels" --data-urlencode "name=ready-for-agent" -d "color=#428BCA"`.

## Merge requests

- Merge requests are numbered apart from issues: `!12` is a merge request, `#12` an issue.
- **Open one**: push the branch, then `curl -sS -H "$AUTH" -X POST "$API/merge_requests" --data-urlencode "source_branch=<branch>" -d "target_branch=master" --data-urlencode "title=..." --data-urlencode "description@body.md"`.
- **Read one**: `curl -sS -H "$AUTH" "$API/merge_requests/<iid>"`, its comments at `.../merge_requests/<iid>/notes`, its changes at `.../merge_requests/<iid>/changes`.

## Keeping GitHub in step

- GitHub is public, and GitLab's `master` has CI commits that name internal hosts. Make each branch from GitHub's `master`, never from GitLab's, and never push GitLab's `master` to GitHub.
- At the hospital: push each branch to both remotes.
- Away from the hospital: push branches to GitHub only.
- Back at the hospital: fetch from GitHub, then push those branches to GitLab and open the merge requests there.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external merge requests as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitLab issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above; for a `GitHub #n` reference, use `gh`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body, and a task list of its children.
- **Child ticket**: an issue with `Part of #<map>` at the top of its body, listed in the map's task list. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's open children, drop any with an open issue on its `Blocked by` line or an assignee; first in map order wins.
- **Claim**: find your user id with `curl -sS -H "$AUTH" "$GITLAB_URL/api/v4/user"`, then `curl -sS -H "$AUTH" -X PUT "$API/issues/<n>" -d "assignee_ids[]=<id>"`, the session's first write.
- **Resolve**: comment the answer on the child, close it, then add a context pointer (gist + link) to the map's Decisions-so-far.
