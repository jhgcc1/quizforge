# Isolating the document fetch — proposal, not a decision

**Status:** open for discussion. Nothing here is implemented, and the recommendation at the end is *not yet*, with the condition
that would change it.

The worker fetches a URL chosen by the user. That is an SSRF surface, and this page is about how much more isolation it deserves.

## What is already true

Facts, read from the code and the infrastructure rather than assumed:

| Defence | Where |
|---|---|
| `https` only, no credentials in the URL, port 443 only | `packages/llm/src/source.ts` |
| Host allow-list — `github.com`, `raw.githubusercontent.com` (`SOURCE_ALLOWED_HOSTS`, not overridden in Terraform, so that default is what production runs) | `apps/worker/src/shared/config.ts` |
| The URL is validated as given, rewritten to the raw host, then validated again | `fetchMarkdown` |
| DNS is resolved first and the fetch is refused if **any** address is private — loopback, RFC1918, CGNAT, multicast, IPv6 ULA and link-local, including `169.254.0.0/16` where the ECS credentials endpoint lives | `isPrivateAddress` |
| Redirects are followed manually, at most 3, each hop re-validated against the allow-list | `fetchMarkdown` |
| 10 s timeout, size cap enforced while streaming, content type checked | `readCapped` |
| The worker's task role can reach **two SQS queues and nothing else** — no S3, no Secrets Manager, no database credentials (those are injected by the execution role at task start) | `terraform/ecs.tf` |
| Fargate has no classic IMDS (`169.254.169.254`) for the task | AWS |

So a successful SSRF today buys: requests from a task whose credentials reach two queues. That is the baseline any further work
is measured against.

## The gap this does not close

The worker lives in the `app` subnet with a route to the `data` subnet, where the database is. An SSRF — or a bug in any code
that handles the fetched bytes — speaks from inside the VPC. The allow-list makes it hard to aim; the topology decides what is
reachable if someone does.

## The proposal

Do the fetch in a **Lambda outside the VPC**, invoked by the worker, which returns `{ text, sha256, bytes, contentType }`.

```
worker (subnet app, role: 2 SQS queues)
   │  invoke
   ▼
fetch-lambda   — no VPC, role: logs only, timeout 15 s, memory 256 MB
   │  https
   ▼
raw.githubusercontent.com
```

* **Outside the VPC is the point.** A function with no VPC configuration has no route into the private subnets: whatever it is
  tricked into requesting, there is no path to the database or to any internal endpoint. The containment comes from the
  topology, not from a rule someone has to keep correct.
* **The role is the second point.** `logs:PutLogEvents` and nothing else. Stolen credentials write a log line.
* The worker keeps **everything else**: the guard, the language policy, the output rails. The text that comes back is exactly as
  untrusted as before. A Lambda that returned "already validated" text would be a design error.

## Trade-offs

| For | Against |
|---|---|
| SSRF moves from *mitigated* to *contained*: no route to the database, no useful credentials | One more component: a function, a role, an invoke permission, a deployment path, a thing to keep in sync |
| Download traffic leaves the NAT Gateway, which is billed per GB and is a real line in this project's cost | The invoke adds latency to every generation (tens of ms) and a new failure mode (Lambda throttling, cold start) |
| Timeout and memory bound the download by construction, in a second place | It protects the risk that is **already the best covered** here, while the open ones are elsewhere |
| The fetch stops being the only code in the VPC that talks to the public internet on user input | Local development needs the direct path anyway, so two code paths exist and only one is exercised in CI |

The cost in money is not the argument: a few cents a month in invocations, against roughly US$10 for the smallest always-on
Fargate task. The cost is the component.

## Alternatives considered

* **Fetch in the user's browser and post the text.** Removes the server-side SSRF entirely — and removes the proof of origin
  with it: "this quiz came from that README" becomes a claim by the client, and the endpoint that accepts 512 KB of arbitrary
  text is easier to abuse than one that requires publishing on GitHub first. The allow-list would also stop being ours: what can
  be fetched would be decided by each host's CORS policy. Rejected for now, for those two reasons.
* **An egress proxy with a domain allow-list** (Squid, or AWS Network Firewall). Stronger than the Lambda for *all* outbound
  traffic, not just the fetch. Network Firewall costs more per month than the whole environment; a self-run proxy is another
  always-on component. Rejected on cost.
* **Pinning the resolved IP for the connection.** Small, local, and closes the theoretical DNS-rebinding window between the DNS
  check and the request. Cheap enough to do on its own merits, independent of this proposal.

## Recommendation

**Not yet.** Two things rank above it, both confirmed by measurement rather than suspected:

1. documents that are not text at all reaching the guard — fixed in this change (`binaryLike`, and the order of the checks);
2. the CPU budget of the guard itself, where a 512 KB adversarial document costs up to 20 s on the half vCPU of a production
   task (see `docs/security/guard-cost.json`).

**What would change the answer:** the allow-list growing beyond GitHub. The moment arbitrary hosts are accepted, the SSRF
surface stops being "two known hosts" and the Lambda becomes the cheapest way to contain it. The same applies if the fetch ever
has to parse something richer than Markdown (PDF, DOCX): parsers are a much larger attack surface than an HTTP GET, and that
work belongs outside the VPC from the first line.
