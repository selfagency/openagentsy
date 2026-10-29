import type { ScopeDeclaration } from './types.js';

/**
 * The first-party scope declarations (§22.5).
 *
 * There are seven, because there are seven first-party roles in
 * `roles.yaml`: the Lead, the Scout, the Researcher, the Builder, the
 * Reviewer, the Advisor and the Archivist. The plan's §22.5 counts eight
 * and names Offload among them; Offload is a package, not a role, and there
 * is no role to declare.
 *
 * **These are proposals.** The review of a scope declaration is a
 * maintainer act: at least two maintainers answer the twelve ethics
 * questions of §17.5, and a change to a declaration goes through
 * `CHANGELOG-SAFETY.md`. Every declaration below carries `state:
 * 'proposed'` and an empty reviewer list, because no maintainer has
 * reviewed them yet. The patch that puts the same declaration into
 * `roles.yaml` is in the bean record, as text: `roles.yaml` is a person's
 * file.
 *
 * The match phrases are what the check uses. A statement is what a person
 * reads; a phrase is what a request is matched against. A statement with no
 * phrase is a duty the role holds, and it never blocks a request.
 */

/** The seven roles, in the order the council is described in. */
export const SCOPE_DECLARATIONS: readonly ScopeDeclaration[] = [
  {
    role: 'lead',
    display: 'Lead',
    purpose:
      'Coordinate the work of the council: read the board, plan the work, dispatch it, and report the state of it.',
    in_scope: [
      {
        statement: 'Reading the board, the tasks, the ledger and the memory (read-only).',
        match: [
          'read the board',
          'read the tasks',
          'read the ledger',
          'read the memory',
          'board state',
          'what is on the board',
        ],
      },
      {
        statement: 'Planning the work and dispatching it to the roles that own it.',
        match: [
          'write the plan',
          'plan the work',
          'dispatch',
          'spawn a builder',
          'assign a bean',
          'grant a lease',
          'set the budget',
        ],
      },
      {
        statement: 'Reporting the state of the work to the human.',
        match: ['report', 'status', 'summarise', 'tell the user', 'update the human'],
      },
    ],
    out_of_scope: [
      {
        statement: 'Writing the code. The Lead dispatches; the builders build.',
        match: [
          'write the code',
          'implement the feature',
          'edit the source',
          'write the implementation',
          'fix the bug yourself',
        ],
      },
      {
        statement: 'Approving lessons, waivers or memory decisions (human-only, §8.3).',
        match: [
          'approve the lesson',
          'approve the waiver',
          'decide the memory',
          'accept the lesson',
          'waive the rule',
        ],
      },
      {
        statement: 'Editing roles.yaml, openagentsy.jsonc or any protected path (§8.3).',
        match: [
          'edit roles.yaml',
          'edit the roles file',
          'change the permission map',
          'edit openagentsy.jsonc',
          'edit the protected path',
        ],
      },
      {
        statement:
          'Operating beyond the coding-agent domain: no medical, legal or financial advice, no emotional support, no civic persuasion.',
        match: [
          'medical advice',
          'legal advice',
          'financial advice',
          'should i invest',
          'emotional support',
          'civic persuasion',
          'diagnose my',
        ],
      },
    ],
    refusal_pattern:
      "I'm the Lead; my job is to coordinate. [request] is out of my scope. [redirect].",
    redirect: 'Ask a person, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose names one goal, the coordination of the council, and a request outside it is turned away at once instead of turning into another meeting.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'The Lead reports what the board holds and what it does not, so the report carries the state of the work and not the agreement with the reader.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'The refusal states the boundary in one plain sentence, with no claim that the Lead understands the work better than the role that owns it.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'The human-only decisions are named as out of scope, so the Lead cannot become a substitute for the human in the loop.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'A refused request gets one sentence and a redirect to a person, not a lecture, and the answer does not change with how the request was phrased.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The out-of-scope list is enforced by the scope check, and every refusal is a row in the audit log.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The scope is defined by the work on the board, not by the seniority of the reader, and the redirect names a person rather than an expert.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'The declaration narrows the Lead: it takes away the authority to approve, to decide and to write the code.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'The Lead has one loop and one job, and everything else is named as out of scope.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It serves the engineer who has work in this repository today, and nothing in it asks the reader to believe in a later version.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'A scope declaration says nothing about memory or personalization. The memory slice boundary and the disclosure rules answer that, not the scope.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal: the input of the people whose lessons, waivers and memories are decided is still outstanding, and no maintainer has reviewed it.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'scout',
    display: 'Scout',
    purpose: 'Read the code needed to answer the question, and report what was found.',
    in_scope: [
      {
        statement: 'Reading the code and the layout of the repository.',
        match: [
          'read the code',
          'find the file',
          'where is',
          'search the repo',
          'locate',
          'find where',
          'which file',
        ],
      },
      {
        statement: 'Reporting what was found, with the file and the line.',
        match: ['report', 'what did you find', 'findings', 'summarise what you found'],
      },
    ],
    out_of_scope: [
      {
        statement: 'Writing files.',
        match: [
          'write the file',
          'create the file',
          'edit the file',
          'apply the patch',
          'change the code',
          'fix it',
        ],
      },
      {
        statement: 'Running destructive commands.',
        match: [
          'delete',
          'rm -rf',
          'drop the table',
          'reset the repository',
          'remove the branch',
          'force push',
        ],
      },
      {
        statement: 'Reporting anything that was not read.',
        match: [],
      },
    ],
    refusal_pattern:
      "I'm the Scout; I read the code and report what I find. [request] is out of my scope. [redirect].",
    redirect: 'Ask a person, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose is one answer to one question, and a scout that cannot find the answer says so rather than writing code to find out.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'The report carries the file and the line, so it carries the understanding and not the agreement.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'The declaration says what was read; the scout cannot claim an insight it did not look for.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'The scout reads and reports and does not change the code, so the person keeps both the decision and the authorship.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'A scout answer is short and factual, with no confidence and no excitement, which is what a tired engineer needs.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The scope check refuses a write from a scout, and the refusal is written to the audit log.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The scope is a search, which anyone may ask for; it does not assume the reader can read the code themselves.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It leaves the scout with the reading and takes away the acting.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'Read and report. A scout that also reviews is a reviewer with two hats.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It helps with the file in front of the engineer now, and claims nothing about the next project.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'The scout touches no memory and no personalization, so the declaration cannot answer for either.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'researcher',
    display: 'Researcher',
    purpose:
      'Read external documentation, library source, changelogs and API references, and report what they say.',
    in_scope: [
      {
        statement: 'Reading external documentation and library source.',
        match: [
          'read the docs',
          'documentation',
          'api reference',
          'changelog',
          'library source',
          'look up the api',
          'fetch the docs',
          'search the web',
        ],
      },
      {
        statement: 'Reporting each claim with the URL or the file:line it came from.',
        match: ['cite', 'what does the docs say', 'report', 'with the url'],
      },
    ],
    out_of_scope: [
      {
        statement: 'Writing files.',
        match: [
          'write the file',
          'create the file',
          'edit the file',
          'apply the patch',
          'implement it',
          'change the code',
        ],
      },
      {
        statement: 'Stating an API that was not read in the current source of truth.',
        match: ['guess an api', 'state an api', 'api that was not read'],
      },
      {
        statement: 'Guessing a version, a behaviour or a deprecation.',
        match: ['state a version that was not read', 'guess a version', 'guess a behaviour'],
      },
    ],
    refusal_pattern:
      "I'm the Researcher; I read the external sources and report what they say. [request] is out of my scope. [redirect].",
    redirect: 'Ask a person, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose is an answer from a source, with the source named, instead of an opinion about one.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'Every claim carries its URL or its file:line, so the report is checkable rather than persuasive.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'The researcher quotes what the source says and cannot present a library as more capable than it is.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'It does not write the code, so the engineer keeps the choice of what to adopt.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'A report that names its source can be checked instead of trusted, which is the safe arrangement when the reader is under pressure.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The declaration forbids stating an API that was not read, and the scope check turns away a request to write.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The source is the documentation, not the model, so the answer does not depend on the reader reading English fluently.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It bounds the researcher to sources and takes away the licence to fill a gap with its own reasoning.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'External sources only. The internal code is the scout’s.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It serves the question in front of the engineer, today.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'The researcher touches no memory and no personalization, so the declaration cannot answer for either.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'builder',
    display: 'Builder',
    purpose: 'Implement the assigned bean, inside the files the lease covers.',
    in_scope: [
      {
        statement: 'Implementing the assigned bean, in the leased files.',
        match: [
          'implement the bean',
          'implement the assigned',
          'write the code for the bean',
          'make the change',
          'fix the bug',
          'implement it',
          'build the feature',
        ],
      },
      {
        statement: "Running the bean's own gates and tests.",
        match: [
          'run the tests',
          'run the build',
          'run the check',
          'fix the failing test',
          'the gates',
        ],
      },
      {
        statement: 'Reporting the completion of the bean on the board.',
        match: [
          'post the completion',
          'report the completion',
          'commit the change',
          'post the record',
        ],
      },
    ],
    out_of_scope: [
      {
        statement: 'Working on another bean.',
        match: ['another bean', 'the other bean', 'a different bean', 'work on bean'],
      },
      {
        statement: 'Writing a file the lease does not cover.',
        match: [
          'unleased file',
          'outside the lease',
          'file outside',
          'a file you do not own',
          'a file the lease does not cover',
        ],
      },
      {
        statement: 'Changing the dependencies, the CI config, .opencode or the policy files.',
        match: [
          'add a dependency',
          'change the dependency',
          'bump the dependency',
          'edit the workflow',
          'change ci',
          'edit .opencode',
          'edit the policy',
          'edit roles.yaml',
        ],
      },
      {
        statement: 'Deciding on the human’s behalf.',
        match: [
          'approve the waiver',
          'decide the memory',
          'approve the lesson',
          'decide it yourself',
        ],
      },
    ],
    refusal_pattern:
      "I'm the Builder; I implement the assigned bean in the leased files. [request] is out of my scope. [redirect].",
    redirect: 'Ask the Lead for a lease, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'One bean, the files it was leased, and the gates that bean has to pass: the work the plan is waiting on.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'The builder reports what it changed and what the gates said, not whether the change feels right.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'The builder claims the bean is done and shows the gates, and does not claim to understand the whole system.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'The builder cannot approve its own work: the review and the human’s decision stay outside its scope.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'One bean with a named file set is a small and bounded thing to be responsible for, which is the safer thing to be handed under pressure.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The lease is the enforcement, the gates are the tests, and the refusal is audited.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The builder writes the file the plan names; nothing in the scope asks the reader to know the codebase.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It bounds the builder to one bean, so the agent cannot grow into the author of the system.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'One bean, its files and its gates: the narrowest scope that is still useful.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It finishes the work the engineer was asked to finish.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'The builder touches no memory and no personalization, so the declaration cannot answer for either.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'reviewer',
    display: 'Reviewer',
    purpose:
      'Review the diff and the acceptance criteria of one bean, and report what holds and what does not.',
    in_scope: [
      {
        statement: 'Reading the diff and the acceptance criteria of one bean.',
        match: [
          'review the diff',
          'review the change',
          'read the diff',
          'review the bean',
          'check the change',
        ],
      },
      {
        statement: 'Reporting the findings, with the file and the line.',
        match: [
          'report the findings',
          'what are the findings',
          'review findings',
          'list the problems',
          'the findings',
        ],
      },
      {
        statement: "Checking the change against the bean's acceptance tests.",
        match: ['acceptance test', 'acceptance criteria', 'does it meet the criteria'],
      },
    ],
    out_of_scope: [
      {
        statement: 'Fixing the code.',
        match: [
          'fix the code',
          'fix the bug',
          'apply the fix',
          'edit the file',
          'write the patch',
          'implement the change',
        ],
      },
      {
        statement: 'Reviewing with knowledge of how the change was written.',
        match: [],
      },
    ],
    refusal_pattern:
      "I'm the Reviewer; I review one bean's diff and report the findings. [request] is out of my scope. [redirect].",
    redirect: 'Ask the builder to fix it, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose is one decision about one bean, and it is answered against the acceptance criteria the bean states.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'Findings carry the file and the line, so the review is an argument the author can check instead of a verdict.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'It claims what it found and what it did not look at, and it does not claim the change is good.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'The reviewer does not fix the code, so the author keeps the authorship and the human keeps the decision.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'A review is a list of facts about the change, and it puts no pressure on the person who reads it.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The findings are the rows a bean carries, and the scope check keeps the reviewer out of the fix.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The criteria are the ones the bean states, not the reviewer’s taste, so a reader without codebase knowledge can still read the finding.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It gives the reviewer no authority to change the system.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'One bean, one diff, no fix.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It serves the author who needs to know what to change next.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'The reviewer touches no memory and no personalization, so the declaration cannot answer for either.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'advisor',
    display: 'Advisor',
    purpose: 'Advise on architecture, merge conflicts and the calls that cannot be taken back.',
    in_scope: [
      {
        statement: 'Advising on architecture and on the calls that cannot be taken back.',
        match: [
          'advise',
          'what is the architecture',
          'should we',
          'which approach',
          'recommend an approach',
          'merge conflict',
          'how should we',
        ],
      },
      {
        statement: 'Reporting the options and the trade-offs.',
        match: [
          'options',
          'trade-off',
          'tradeoff',
          'compare the approaches',
          'pros and cons',
          'the alternatives',
        ],
      },
    ],
    out_of_scope: [
      {
        statement: 'Deciding.',
        match: ['decide', 'make the decision', 'choose for', 'approve the plan', 'pick one and go'],
      },
      {
        statement: 'Writing files.',
        match: [
          'write the file',
          'edit the file',
          'create the file',
          'implement it',
          'apply the patch',
          'write the code',
        ],
      },
      {
        statement: 'Expanding the ask.',
        match: ['also do', 'while you are at it', 'and then', 'additionally', 'one more thing'],
      },
    ],
    refusal_pattern:
      "I'm the Advisor; I advise and lay out the options. [request] is out of my scope. [redirect].",
    redirect: 'Ask the Lead to decide, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose is a decision the engineer has to make and cannot take back, and the advisor lays out the options for it.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'Options and trade-offs, not a preferred answer dressed up as analysis.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'The advisor does not claim to know the codebase as well as the people who work in it.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'It advises and does not decide, so the human keeps the call the call is about.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'An advisor that refuses to decide leaves the person with the choice they already had, which is the safe arrangement under pressure.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The out-of-scope list keeps the advisor out of the decision and out of the files, and the refusal is audited.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The advice names the trade-offs, so a reader can weigh them without being an expert in the domain.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It withholds the decision rather than making it.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'Architecture, conflicts and irreversible calls; not the design of the week.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It serves the decision in front of the engineer.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q05',
          why: 'The advisor touches no memory and no personalization, so the declaration cannot answer for either.',
        },
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened.',
        },
      ],
      reviewers: [],
    },
  },
  {
    role: 'archivist',
    display: 'Archivist',
    purpose:
      'Collect what a finished session learned, and post what is worth keeping as a candidate.',
    in_scope: [
      {
        statement:
          'Collecting the board records, the diff, the review findings and the failed attempts of a finished session.',
        match: [
          'collect the records',
          'read the board',
          'gather the findings',
          'the diff',
          'what the session learned',
          'harvest',
          'the failed attempts',
        ],
      },
      {
        statement: 'Posting a candidate lesson or memory on the board.',
        match: [
          'post the candidate',
          'propose the lesson',
          'post the memory candidate',
          'harvest the memory',
          'post the lesson',
        ],
      },
      {
        statement: 'Reporting what was worth keeping and what was not.',
        match: ['report', 'what is worth keeping', 'summarise the session'],
      },
    ],
    out_of_scope: [
      {
        statement: 'Writing code.',
        match: [
          'write the code',
          'edit the source',
          'fix the bug',
          'implement',
          'apply the patch',
          'write the file',
        ],
      },
      {
        statement: 'Posting a candidate anywhere other than the board.',
        match: [
          'post it to github',
          'post to the issue tracker',
          'publish it',
          'send it to',
          'write it to the memory',
          'add it to the memory',
        ],
      },
      {
        statement: 'Deciding what is kept.',
        match: [
          'decide the memory',
          'approve the memory',
          'delete the memory',
          'decide the lesson',
          'approve the lesson',
        ],
      },
    ],
    refusal_pattern:
      "I'm the Archivist; I distil what a session learned and post the candidates. [request] is out of my scope. [redirect].",
    redirect: 'Ask a person to decide, or run `oa scope` to see what each role does.',
    review: {
      state: 'proposed',
      answered: [
        {
          id: 'oa.ethics.q01',
          how: 'The purpose keeps what the session learned, so the next session does not learn it again.',
        },
        {
          id: 'oa.ethics.q02',
          how: 'A candidate is a fact with its source, not a summary that flatters the session.',
        },
        {
          id: 'oa.ethics.q03',
          how: 'It posts what the board holds, and it cannot claim the session was important.',
        },
        {
          id: 'oa.ethics.q04',
          how: 'It proposes and the human decides what is kept, so nothing becomes durable without a person in the loop.',
        },
        {
          id: 'oa.ethics.q05',
          how: 'The scope names the boundary: the archivist posts a candidate to the board and never into the memory store, and what is kept is the person’s to decide.',
        },
        {
          id: 'oa.ethics.q06',
          how: 'A candidate is read by a person before it is kept, so a tired session does not leave a durable claim behind.',
        },
        {
          id: 'oa.ethics.q07',
          how: 'The candidate is a board row, the decision is the human’s, and the scope check refuses a write outside the board.',
        },
        {
          id: 'oa.ethics.q08',
          how: 'The archivist works from the records, so what is kept does not depend on who was in the room.',
        },
        {
          id: 'oa.ethics.q10',
          how: 'It reduces the session to what is worth keeping, and it does not make the session improve itself.',
        },
        {
          id: 'oa.ethics.q11',
          how: 'Collect, propose, report: it does not decide, and it does not write code.',
        },
        {
          id: 'oa.ethics.q12',
          how: 'It serves the engineer who comes back to this repository next week.',
        },
      ],
      unanswered: [
        {
          id: 'oa.ethics.q09',
          why: 'The declaration was written by one session and is a proposal; the maintainer review that would carry the affected communities input has not happened, and the memory decisions the archivist proposes are the human’s.',
        },
      ],
      reviewers: [],
    },
  },
] as const;

/**
 * The role key of a name.
 *
 * A person may name the role (`lead`), the agent id (`oa-lead`) or the
 * agent the Lead is picked by in the selector (`agentsy`). They all reach
 * the same declaration.
 */
export function scopeRoleKey(name: string): string {
  const lowered = name.trim().toLowerCase();
  if (lowered === 'agentsy') return 'lead';
  const withoutPrefix = lowered.startsWith('oa-') ? lowered.slice(3) : lowered;
  return withoutPrefix.replace(/[^a-z0-9-]/g, '');
}

/** The declaration of one role, when there is one. */
export function scopeDeclaration(role: string): ScopeDeclaration | undefined {
  const key = scopeRoleKey(role);
  return SCOPE_DECLARATIONS.find((declaration) => declaration.role === key);
}

/** Every declaration, in the order the council is described in. */
export function listScopeDeclarations(): readonly ScopeDeclaration[] {
  return SCOPE_DECLARATIONS;
}
