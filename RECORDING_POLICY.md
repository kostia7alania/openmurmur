# Recording policy

**Read this before running OpenMurmur anywhere other people might speak.**

This is the part of the project most likely to cause real harm, so it is stated
directly rather than hidden in a licence file.

## The short version

OpenMurmur records continuously. It cannot tell who is in the room. If you run
it around other people without their knowledge, you may be committing a crime,
and you will certainly be doing something most people would consider a betrayal
of trust.

## Legal reality

Recording law varies enormously and this is **not legal advice**.

**All-party (two-party) consent** — every participant must consent. Includes
California, Florida, Illinois, Pennsylvania, Washington and several other US
states, and much of the EU. Violations are frequently **criminal**, not merely
civil.

**One-party consent** — only one participant (which can be you) must consent.
Includes most US states and the UK for private use.

**Additional restrictions** commonly apply regardless of consent rules:

- Workplaces often prohibit recording by policy or by union agreement.
- Medical, legal, financial and educational settings carry extra duties.
- GDPR treats a voice recording of an identifiable person as personal data, and
  "I was journaling" is not a lawful basis for processing someone else's.
- Some jurisdictions distinguish recording a *conversation you are part of* from
  recording *ambient speech*, which is what this software does.

Consequences range from evidence being inadmissible, through civil damages, to
criminal prosecution. In several US states, unlawful recording is a felony.

## What you should do

**Tell people.** Before they speak, not afterwards. "I have an app that records
and transcribes for me — is that okay?" It takes five seconds and resolves
almost every problem in this document.

**Stop when asked.** Immediately and without argument.

```bash
openmurmur stop
```

**Do not run it in:** meetings without disclosure, shared offices, therapy or
medical appointments, legal consultations, other people's homes, classrooms, or
anywhere with an expectation of privacy you do not control.

**Do not use it to:** gather evidence against someone, monitor employees or
family members, capture conversations you were not part of, or record anyone who
has said no.

**Check your local law** before running it around anyone. Once, properly.

## What OpenMurmur does and does not do

**Does:** rely on the macOS orange microphone indicator, which is visible to
anyone looking at your screen. Report recording state clearly in Telegram. Give
you `openmurmur stop`. Provide retention controls and a proof-based deletion
path.

**Does not:** detect who is present. Detect whether consent was given. Notify
people in the room. Add a second consent dialog — macOS already asks you, and a
second prompt trains people to click through prompts.

**The system indicator is deliberately not suppressed.** Any change that hid,
replaced or disabled it would be rejected.

## Your responsibility

You are the operator. You choose where the microphone is, when the daemon runs,
and who is nearby.

The Apache-2.0 licence disclaims warranty and liability (sections 7 and 8). That
is a legal statement about the software. This document is a practical one:
**the software cannot protect people from you. Only you can do that.**

## Contributions

Pull requests that make covert recording easier will be rejected. This
specifically includes: hiding or suppressing the macOS indicator, disguising the
process, removing status reporting, or adding remote activation.

Improvements that make consent easier — a spoken pause phrase, clearer status,
scheduled quiet hours — are welcome.
