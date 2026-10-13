# ANU TaskMate

TaskMate is a mutual-support board for ANU students: post a paid or free
opportunity, or apply to one someone else posted. It is not a gig
marketplace, and it is not trying to become one. It is small on purpose,
built for one known audience — ANU students who already share an email
domain, a campus, and a semester — rather than designed to generalise to
the open web.

## What "good" means here

Aral Balkan's [*What is the Small Web?*](https://ar.al/2020/08/07/what-is-the-small-web/)
draws a line between software built to serve an anonymous mass of "users"
and software built to serve specific, known people. TaskMate sits firmly
on the small side of that line: every post and application belongs to a
real ANU student, not an account manufactured for the platform's growth.
Good, for this app, is not "many students"; it's "the students who show
up can trust what they see and get an honest answer back quickly."

Devontae Williams' ["The Best Software Solves Small Problems Completely"](https://notesofanomad.substack.com/p/the-best-software-solves-small-problems)
argues that a small tool earns trust by fully resolving the one thing it
promises, rather than half-covering a long feature list. That shaped the
scope decision behind this crit: TaskMate does not yet have reviews,
reputation, payments, or messaging. Those are real parts of the eventual
app, but bolting them on now, unfinished, would make the one thing this
version does — post something, see it live, apply to it — less
trustworthy, not more. What's here is meant to work completely.

Concretely, "good" for TaskMate means:

- **It tells people apart.** Every visitor gets their own session and a
  display name they chose; the server, not just the browser, knows who
  posted what and who applied to what.
- **It's honest about state.** What one student sees should match what's
  actually stored, and what another student sees of the same post, within
  about a second — not "eventually," and not only after a manual refresh.
- **It doesn't pretend to close doors it can't close.** Multiple students
  can apply to the same opportunity at once; TaskMate doesn't quietly drop
  an application to make the count look tidy, and it doesn't shut a post
  the moment one person applies. Deciding who actually participates is a
  human judgement call for the post's author, deliberately left outside
  this version's scope.
- **It survives.** A post made today is still there tomorrow, after a
  restart, after a redeploy — the small amount of state this app holds is
  the thing it's actually accountable for.

## What's in this version

Four categories — Campus Help, Study Together, Social Connect, Campus
Events — covering both paid and free posts. A community feed, a form to
publish a post, and the ability to apply to someone else's post. New
posts and application counts update live across open browser sessions.

## What's deliberately not here yet

Reviews, completion rates, direct messaging, full verified-identity
accounts, payments, and reputation. These belong to the fuller A3 version
of TaskMate, once the smaller, completely-working core above has proven
itself.
