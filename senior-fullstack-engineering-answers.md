# Engineering Questionnaire

**Nicolas Van Klaveren** — Senior Full Stack Engineer · Backend-focused

Answers below are my own and reflect my experience. The code snippets are illustrative examples of the approach, not production code.

## Backend and Go

### 1. How do you handle concurrency in Go? How do you avoid goroutine leaks?

Concurrency in Go is structured by convention: every goroutine has an owner and a lifetime. Three rules.

First, the context is the cancellation channel. I pass ctx as the first argument, derive children with context.WithTimeout, and always defer cancel() right after the call. Cancellation is cooperative: nothing is interrupted unless the goroutine selects on ctx.Done(), so every blocking call has to be context aware.

Second, concurrency is bounded. An unbounded fan-out is a self-inflicted outage, so I cap in-flight work with a semaphore or errgroup.SetLimit, matching what the dependency can absorb.

Third, goroutines have an owner and the owner waits: every WaitGroup or errgroup is joined before the function returns, and the goroutine that opened a resource closes it.

A leak is a goroutine blocked forever, on a channel nobody reads, on a mutex, on a network read that never returns. So every select has a ctx.Done() case, sends happen inside a select, and I keep goroutine count as a metric, because a leak shows up as a count that only grows.

In the agent platform I built, a watch-mode reload mid-job left a job finished but hung, and the runner marked it failed. The fix was architectural: isolating each job in its own process, which became an architecture decision record rather than a patch.

**Illustrative example (go)**

```go
func fetchAll(ctx context.Context, ids []string, f func(context.Context, string) (Item, error)) ([]Item, error) {
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(8) // concurrency limit: never more than 8 calls at a time

	out := make([]Item, len(ids))
	for i, id := range ids {
		i, id := i, id
		g.Go(func() error {
			// every blocking call is ctx-aware: cancellation is cooperative
			item, err := f(gctx, id)
			if err != nil {
				return fmt.Errorf("fetch %s: %w", id, err)
			}
			out[i] = item
			return nil
		})
	}
	// the owner waits: no goroutine outlives this function
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

// a send that cannot deadlock: no blocking channel send
select {
case jobs <- job:
case <-ctx.Done():
	return ctx.Err()
}
```

### 2. How do you handle errors in Go, and how does that differ from exceptions?

In Go an error is a value, not an exception. There is no throw, no stack unwinding, no catch: the function returns an error and the caller decides. That is the whole difference with exceptions, and it is a design decision.

Because an error is a value, it can be inspected, wrapped, compared and tested. I use three levels. Sentinels, like sql.ErrNoRows or my own ErrNotFound, for the cases a caller branches on. Typed errors, like a ValidationError carrying the field and the reason, when the caller needs details to build a 422. And wrapped errors for context: fmt.Errorf with %w, so the original cause is not lost.

I check errors immediately, never compare error strings, and at the boundary, usually the HTTP handler, I translate the error into a status with errors.Is and errors.As, log it once with the request id, and turn anything unrecognised into a generic 500 with the detail only in the logs.

A panic is a bug, not control flow. I use recover in a defer, and I know the rule: recover only catches a panic in the same goroutine, so a panic in a child goroutine takes the process down, which is often what I want, with the supervisor restarting it.

And I wrap the error that adds context while returning the cause, so five layers deep still answer what actually failed, without a log line per layer.

**Illustrative example (go)**

```go
var (
	ErrNotFound = errors.New("not found")
	ErrConflict  = errors.New("conflict")
)

// typed error: carries the detail the caller needs
type ValidationError struct {
	Field  string
	Reason string
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Reason }

// service layer: context + preservation of the cause
if err != nil {
	return fmt.Errorf("load invoice %s: %w", id, err)
}

// HTTP boundary: status decision and a single log line
switch {
case errors.Is(err, sql.ErrNoRows), errors.Is(err, ErrNotFound):
	return nil, writeErr(w, http.StatusNotFound, "invoice not found")
case errors.As(err, &verr):
	return nil, writeErr(w, http.StatusUnprocessableEntity, verr.Error())
case errors.Is(err, ErrConflict):
	return nil, writeErr(w, http.StatusConflict, "conflict")
default:
	// detail in the log, generic response
	logger.Error("invoice request failed", "err", err)
	return nil, writeErr(w, http.StatusInternalServerError, "internal error")
}
```

### 3. How would you design a POST endpoint so that sending the same request twice does not create duplicates?

The guarantee has to come from the database, not from application logic, because two concurrent requests can both pass an application-level check. So the client sends an idempotency key, a UUID per logical operation, and I store it with a unique constraint scoped by tenant, plus a hash of the request body.

The flow is one transaction. I insert the key with the hash and an in-progress status using insert on conflict do nothing returning. If it returns a row, I own the operation: I do the business write and store the response in the same row and commit. If it returns nothing, the other request won: in PostgreSQL my insert blocks on the unique index while the other transaction is open, and returns empty only because the other one committed.

Then I re-read the row in a new statement, which under read committed sees the committed data. Done: I replay the stored response. Still in progress: the other request has not finished, so I answer 409. Same key, different hash: the client reused the key with another payload, that is 422.

Two things people forget. The unique constraint is the real lock, and a unique violation would abort my transaction, which is why the insert uses on conflict do nothing. And a transaction does not make external effects idempotent: a payment goes out through an outbox with a deduplicating consumer, or the downstream call receives the same key.

**Illustrative example (sql)**

```sql
create table idempotency_keys (
  tenant_id       bigint      not null,
  idempotency_key text        not null,
  request_hash    bytea       not null,
  status          text        not null default 'in_progress', -- in_progress | done
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

-- insert that does not abort the transaction on conflict
insert into idempotency_keys (tenant_id, idempotency_key, request_hash, status)
values ($1, $2, $3, 'in_progress')
on conflict (tenant_id, idempotency_key) do nothing
returning idempotency_key;

-- 0 rows  -> the other request won (this insert waited for its commit)
-- 1 row   -> I own it: do the business write and store the response
-- re-read in a NEW statement (read committed sees the other commit):
select status, response_status, response_body
from idempotency_keys
where tenant_id = $1 and idempotency_key = $2;
```

### 4. Offset pagination vs cursor (keyset) pagination: when would you use each?

Both paginate, but they fail differently. Offset pagination asks the database to count and discard everything before the offset, so the cost grows with the depth of the page, and it shifts under the user's feet: if a row is inserted while the user is on page three, that row shows up twice or is skipped, because the offset is a position, not a place. Offset is fine for small lists, page-number navigation and exact counts.

Keyset, or cursor pagination, encodes the last row the user saw. I order by a deterministic composite key, for example created_at and id, and the predicate is a tuple comparison, where created_at and id are less than the cursor values, with a matching composite index on tenant_id, created_at, id. The database seeks in that index and reads only the rows it returns, so the work no longer grows with depth. The id tiebreaker makes the ordering total, which stops rows with the same timestamp from repeating or disappearing between pages.

Two honest caveats. It is not a snapshot: if the sort key is updated or the row deleted, a page can still skip or repeat, and a strict snapshot needs an append-only or versioned table. And you lose random access, so no page 57, and an exact count needs a separate query; I usually return a has_more flag from limit plus one rows.

In the API the cursor is opaque base64, validated server side, because it is client input.

**Illustrative example (sql)**

```sql
-- keyset: seek in the index, work no longer grows with depth
select id, created_at, title
from invoices
where tenant_id = $1
  and (created_at, id) < ($2, $3)   -- cursor = last tuple of the previous page
order by created_at desc, id desc
limit 50;

create index idx_invoices_tenant_created_id
  on invoices (tenant_id, created_at desc, id desc);

-- offset: acceptable for small lists; the cost grows with depth
select id, created_at, title
from invoices
where tenant_id = $1
order by created_at desc, id desc
limit 50 offset 5000;
```

### 5. (Only if no production Go) What statically typed language do you use, and how would you ramp up on Go?

Since the question is conditional, let me answer it directly: I have about a year of Go in production, at BTG Pactual, in 2021 and 2022. That is the whole Go history I claim. My production work is mostly .NET and TypeScript, and Go shows up today as the worker in the agent platform I maintain, with the same three disciplines: bounded concurrency, cooperative cancellation, and a queue with claim and heartbeat.

If you want to know how I would ramp someone else onto Go, my plan is short. The standard library first: context, errors, sync and the io interfaces are where the work is, because Go hands you the pieces and expects you to assemble them, and a framework hides exactly the parts that matter. Concurrency on day one: a bounded worker pool with cancellation, because ownership and cancellation are the two things you cannot learn from syntax. And review by someone who reads Go, because the compiler catches type errors but not ownership errors.

The rule I give people is simple: do not port your old abstractions. Go code that feels like C# is worse than Go code that feels like Go.

**Illustrative example (go)**

```go
// worker pool with cancellation and a clean shutdown
func Run(ctx context.Context, tasks []Task) error {
	jobs := make(chan Task) // unbuffered: no unbounded queue in memory
	g, gctx := errgroup.WithContext(ctx)

	// The concurrency limit is the number of workers (8).
	// SetLimit is not used here: with the producer in the same group, a
	// limit equal to the worker count would be fully occupied by the
	// workers and the producer would wait for a slot -> deadlock.
	for i := 0; i < 8; i++ {
		g.Go(func() error {
			for {
				select {
				case <-gctx.Done():
					return gctx.Err()
				case t, ok := <-jobs:
					if !ok {
						return nil
					}
					if err := t.Run(gctx); err != nil {
						return err
					}
				}
			}
		})
	}

	g.Go(func() error {
		defer close(jobs) // whoever sends is who closes
		for _, t := range tasks {
			select {
			case jobs <- t:
			case <-gctx.Done():
				return gctx.Err()
			}
		}
		return nil
	})

	return g.Wait() // the owner waits
}
```

## SQL and PostgreSQL

### 6. A query on a table with 50 million rows became slow. Walk me through how you investigate it.

I start by bounding the problem, because slow is not an investigation. Is it one query or all of them, is it a regression after a release, and how much of the latency is actually in the database? I look at the slow query log or pg_stat_statements sorted by total time, to find the queries that really hurt.

Then I look at the plan, with EXPLAIN ANALYZE and BUFFERS, because the gap between estimated and actual row counts is usually where the story is. I am careful about where I run it: EXPLAIN ANALYZE executes the query, so in production I run it inside a transaction with a statement timeout and a lock timeout, on a read-only statement, and I roll back. On a mutating query I reproduce it on a copy with similar volume.

What I look for: a sequential scan that used to be an index scan, statistics that went stale after a bulk load, an index that exists but is never used, bloat with autovacuum falling behind, and lock waits, where the query is queued behind another transaction.

Then I fix it and prove it: an index matching the predicate and the sort, a rewrite that avoids the expensive part, or batching. I compare the plan and check the p95 of that endpoint before and after, then close with prevention: an alert on endpoint latency and a query budget in CI.

**Illustrative example (sql)**

```sql
-- 1) who is burning the time
select calls, mean_exec_time, total_exec_time, query
from pg_stat_statements
where mean_exec_time > 100
order by total_exec_time desc
limit 20;

-- 2) real plan (WARNING: EXPLAIN ANALYZE EXECUTES the query)
begin;
set local statement_timeout = '2s';
set local lock_timeout = '1s';
explain (analyze, buffers) select ... ;   -- read only
rollback;

-- 3) statistics and autovacuum
select relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, last_autovacuum
from pg_stat_user_tables
where relname = 'invoices';

-- 4) indexes: do they exist, are they used?
select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
from pg_stat_user_indexes
where relname = 'invoices'
order by idx_scan;

-- who is blocking whom
select blocked.pid, blocking.pid, left(blocked.query, 120) as blocked_query
from pg_stat_activity blocked
join pg_stat_activity blocking
  on blocking.pid = any(pg_blocking_pids(blocked.pid));
```

### 7. Two requests try to update the same record at the same time. How do you prevent inconsistent data?

I separate two different problems. The first is preventing the database from holding an invalid state, and that is the job of constraints: not null, check, foreign keys and unique indexes. Those hold no matter what the application code does, so they are my first line of defence.

The second is preventing a lost update, where two requests read the same row and the second write silently overwrites the first. For that I use optimistic concurrency by default: the table has a version column, the update carries the version the client read, and I check how many rows it affected. One row means I won the race; zero means somebody else wrote first, so I return a conflict with the current state instead of overwriting it.

When the read-modify-write is long, the row is hot, or it spans several rows, I switch to pessimistic locking: select for update inside a transaction, which serialises the writers. I keep that transaction short and never call an external system inside it, because a transaction waiting on the network holds locks for a long time.

I also prefer atomic statements: one update that increments a counter, instead of reading the value and writing it back. That removes the race instead of detecting it. Isolation is the last dial: read committed plus row locks is enough for most cases, and I move to serializable only with a genuine write-skew risk, accepting the retry semantics.

**Illustrative example (sql)**

```sql
alter table invoices add column version bigint not null default 0;

-- the write only happens if the version is still the one the client read
update invoices
set status = $2,
    amount_cents = $3,
    version = version + 1
where id = $1
  and version = $4;   -- expected version

-- in Go: rows affected == 0 means "somebody else won"
-- tag.RowsAffected() == 0  ->  ErrVersionConflict (409 with current state)

-- a business rule that is unique only in part of the domain
create unique index uniq_invoice_open_per_customer
  on invoices (tenant_id, customer_id)
  where status in ('open', 'overdue');
```

### 8. How do you run a schema migration on a large table without downtime?

I use expand, migrate, contract, and I never mix the three phases in the same deploy.

Expand is additive and backwards compatible. I add the new column as nullable, because a volatile default rewrites the whole table, while a non-volatile default is metadata only in modern Postgres. I create the index with create index concurrently, which cannot run inside a transaction and does not block writes while it runs. I add the constraint as not valid, which takes a brief lock and does not scan the table, and the application writes both columns, so old and new code coexist during the window.

Migrate is the backfill. Small batches, each in its own transaction, walking the table with a keyset scan so I do not hold a long range of locks, with a pause between batches. In every batch I set lock_timeout and statement_timeout, so a blocked batch fails fast instead of piling up behind production. I watch replica lag and WAL volume, and I let the concurrent index finish, because the backfill gets much faster once the index exists.

Contract comes last: after the code stopped reading the old column, I validate the constraint, which takes a share-update-exclusive lock without blocking reads or writes, and drop the old column.

One caveat about rollback: while the old column is there, undoing is easy. After the drop, the data is gone and the rollback is a restore, not a migration.

**Illustrative example (sql)**

```sql
-- EXPAND: new nullable column (a volatile default would rewrite the table)
alter table invoices add column total_cents bigint;

-- index without blocking writes: OUTSIDE a transaction block
create index concurrently idx_invoices_total_cents on invoices (total_cents);

-- new constraint without validation (supported for FK and CHECK)
alter table invoices add constraint invoices_total_check
  check (total_cents >= 0) not valid;

-- MIGRATE: one batch (repeat in separate transactions, with a pause between)
begin;
set local lock_timeout = '1s';
set local statement_timeout = '30s';
update invoices
set total_cents = amount_cents
where id in (
  select id from invoices
  where total_cents is null and id > :last_id   -- keyset scan
  order by id
  limit 5000
);
commit;

-- real validation: SHARE UPDATE EXCLUSIVE, does not block reads or writes
alter table invoices validate constraint invoices_total_check;

-- CONTRACT (only after the code stopped reading the old column)
-- WARNING: DROP COLUMN needs ACCESS EXCLUSIVE even though it is metadata.
-- Use lock_timeout and a low-traffic window.
set lock_timeout = '1s';
alter table invoices drop column amount_cents;
```

## Frontend (React / TypeScript)

### 9. How do you manage server data in a React app, for example a list that the user can edit?

I treat server data and client data as two different things. Server data lives in a query cache, and I use TanStack Query for that, because the problems of server data are caching, staleness, retries and deduplication, and those are not the problems of a state container. Client state, meaning form fields, filters and UI flags, stays in the component or in a form library. I never mirror server data into a global store: the moment you copy it there, you own two sources of truth.

For a list the user can edit, the shape is one query for the list and one mutation per operation. The mutation does the optimistic update properly: cancel the in-flight queries for that key, snapshot the cache, write the new value into the cache, return the snapshot. If the request fails I restore the snapshot, so the UI rolls back. When it settles I invalidate the list query, so the server stays the source of truth.

The concurrency part matters more than the optimistic part. Two edits to the same row can race, so I scope the mutation per item: writes for that item serialise, while different rows update in parallel. And when the server detects a real conflict it answers 409, and I invalidate and show the current value, because silently overriding the user's edit is worse than telling them.

**Illustrative example (typescript)**

```typescript
const qc = useQueryClient();

const rename = useMutation({
  mutationFn: (v: { id: string; name: string }) =>
    api.patch(`/invoices/${v.id}`, { name: v.name }),

  onMutate: async (v) => {
    // 1) drop in-flight responses that would come back with old data
    await qc.cancelQueries({ queryKey: ['invoices'] });
    // 2) snapshot, so the update can be reverted
    const previous = qc.getQueryData<Invoice[]>(['invoices']);
    // 3) optimistic patch
    qc.setQueryData<Invoice[]>(['invoices'], (old) =>
      old?.map((inv) => (inv.id === v.id ? { ...inv, name: v.name } : inv)));
    return { previous };
  },
  onError: (_err, _vars, ctx) => {
    qc.setQueryData(['invoices'], ctx?.previous);   // rollback
  },
  onSettled: () => {
    qc.invalidateQueries({ queryKey: ['invoices'] }); // reconcile with the server
  },
});

// scope per item: two edits of the same record do not race
rename.mutate({ id, name }, { scope: { id } });
```

## Architecture, cloud and events

### 10. When would you deploy a service on Kubernetes and when would you use a managed AWS service like Lambda, ECS Fargate or SQS?

My default is the least operational surface that still meets the requirements, and the decision is driven by the shape of the workload, not by fashion.

Lambda fits spiky, event-driven work: short tasks, queue consumers, scheduled jobs, anything whose volume is mostly idle. The trade-offs are cold starts, which matter on latency-sensitive paths, and the limits on the request shape. SQS and SNS are the data plane I reach for first when a component needs decoupling, because a queue gives me buffering, retry with visibility timeout and backpressure without running a broker.

ECS Fargate fits containers that run continuously: long-running services, workers, anything I ship as a container, with modest operational effort and predictable cost.

Kubernetes is worth it when the workload needs something the managed runtime does not give me: custom networking and policies, a shared platform for several teams, specialized scheduling such as GPUs, or the same behaviour across environments. The cost is real and I know it from running infrastructure before I became a developer: somebody owns the control plane, the upgrades, ingress, autoscaling, secrets and the on-call for the platform itself. Managed Kubernetes removes the control plane, not the platform work.

So the data plane is usually managed, and I reach for Kubernetes only when the workload shape justifies it. In one system I built I ran a small Kubernetes cluster because the workers needed strict network isolation and outbound-only access.

**Decision matrix (illustrative)**

| Workload | Typical choice | Why | Main caveat |
| --- | --- | --- | --- |
| Spiky events, mostly idle | Lambda | pay per execution, no server to run | cold start on a critical path |
| Continuously running container | ECS Fargate | ships what is already a container, predictable cost | network and scaling operations |
| Asynchronous decoupling | SQS / SNS | buffering, retry, backpressure | visibility timeout, idempotent consumer |
| Custom networking or policies, GPUs, many teams | Kubernetes (EKS or self-managed) | scheduling and isolation control | control plane and platform cost |

### 11. What is the N+1 problem in GraphQL and how do you solve it?

N plus one is when one query for the top-level resource triggers one additional query per item. A list of a hundred invoices becomes a hundred and one round trips, and the latency of the response becomes the sum of them. It hides well in development with ten records and collapses in production with a few thousand.

The standard fix is batching with DataLoader. The resolver does not hit the database, it asks the loader for the ids it needs. The loader collects the keys across the level of the query tree and, at the end of the tick, runs one query with an any clause and returns the results indexed by key. A hundred invoices then produce one query with an array of ids.

The implementation details are where this goes wrong. The loader instance must be created per request, usually in the context factory: a module-level loader keeps its cache across requests, which leaks data between users and leaks memory. The cache key has to include every argument, and the loader must preserve the order and the length of the keys it was given, including nulls.

The same problem appears as lazy loading inside a resolver, and there the fix is eager loading or the same loader, not a big join, which duplicates parent rows.

Batching treats the symptom, not the abuse, so I add depth and complexity limits and persisted queries.

**Illustrative example (typescript)**

```typescript
// one loader per request, created in the context factory
export function createLoaders(db: Db) {
  const userById = new DataLoader<string, User>(async (ids) => {
    // ONE query for the whole level
    const rows = await db.query(
      'select id, name from users where id = any($1::text[])', [ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // preserve order and length: one result per key, null when missing
    return ids.map((id) => byId.get(id) ?? null);
  });
  return { userById };
}

// resolver
users: async (_parent, { ids }, ctx) => {
  // loadMany triggers ONE batch for the whole level of the query
  const users = await ctx.loaders.userById.loadMany(ids);
  return users;
}
```

### 12. If a service publishes events to Kafka, how do you guarantee that the database and the event stay consistent?

First the honest framing: without a distributed transaction you cannot make the database commit and the Kafka publish one atomic operation, and I would not pay for one. The goal is that no event is lost and that a duplicate never causes damage.

The pattern I use is the transactional outbox. The service writes the business change and a row in an outbox table inside the same database transaction. If the transaction commits, both the change and the intent to publish are durable; if it rolls back, there is no event. That removes the dual-write bug, where the row is committed but the process crashes before publishing.

Then a relay reads the outbox and publishes to Kafka. It claims rows with for update skip locked, so several relays run in parallel without colliding, and marks a row published only after the broker acknowledges. Delivery is at least once: the relay can crash between publishing and marking, and then the event goes out twice. That is only acceptable if the consumer is idempotent: the consumer writes the event id into an inbox table with a unique constraint, in the same transaction as its own state change.

On ordering, Kafka guarantees it only within a partition, so the partition key is the aggregate id, which gives per-entity ordering.

On exactly once, Kafka transactions cover consume-process-produce inside Kafka, not a change in PostgreSQL. For that: outbox plus idempotent consumer.

**Illustrative example (sql)**

```sql
-- outbox: written in the SAME transaction as the business change
create table outbox (
  id             bigserial primary key,
  aggregate_type text        not null,
  aggregate_id   text        not null,
  event_type     text        not null,
  payload        jsonb       not null,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);

-- partial index: only pending rows are relay candidates
create index idx_outbox_pending on outbox (id) where published_at is null;

-- consumer inbox: deduplication with a unique constraint
create table inbox (
  consumer      text        not null,
  event_id      bigint      not null,
  processed_at  timestamptz not null default now(),
  primary key (consumer, event_id)
);

-- in the consumer, in the SAME transaction as its state change:
insert into inbox (consumer, event_id) values ($1, $2)
on conflict do nothing;
-- 0 rows => already processed => skip
```

### 13. Which infrastructure have you managed with Terraform, and how do you handle state?

Yes, I have used Terraform in production, and Ansible alongside it for the parts that are configuration rather than resources. The resources change per environment, so what I care about is the discipline around them, not a fixed inventory.

On Terraform, the practice I care about is that the environment is described as code, reviewed like code, and that I can read the diff before it is applied.

The state is where teams get hurt, so that is where I focus. My principles: the state never lives in a git repository, it is stored in a remote backend; the state store is encrypted and versioned, so an accidental apply can be rolled back to the previous state; each environment has its own state, through separate backends or a strict convention in the key; concurrent applies are prevented with a lock; and the state stays out of the apply path on a laptop, with plan running in CI on every pull request and apply running from a protected pipeline with short-lived credentials.

For the S3 backend specifically, the setup I would recommend is a dedicated bucket with versioning enabled and server-side encryption, one key per environment, and the native lockfile where the backend and the Terraform version support it. With older versions, a lock table is the equivalent.

With Ansible the rules are different but related: playbooks are idempotent, so running them twice changes nothing; I use modules instead of shell commands, declare the desired state, and use check mode to see what would change before applying.

The principle behind both: infrastructure is code, reviewed like code, and the state of the world is described, never adjusted by hand.

**Illustrative example (hcl)**

```hcl
# illustrative backend: remote state, encrypted, versioned, locked
terraform {
  backend "s3" {
    bucket       = "acme-tfstate-prod"
    key          = "payments/prod.tfstate"
    region       = "sa-east-1"
    encrypt      = true          # server-side encryption
    use_lockfile = true          # native S3 locking (Terraform >= 1.10)
  }
}

# the state bucket is versioned, so an accidental apply can be reverted
resource "aws_s3_bucket" "tfstate" {
  bucket = "acme-tfstate-prod"
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

# an example of a managed resource
resource "aws_sqs_queue" "invoice_events" {
  name                       = "invoice-events"
  sqs_managed_sse_enabled   = true
  visibility_timeout_seconds = 120
}
```

## Testing, CI and production

### 14. How do you test a Go service that talks to PostgreSQL?

I split the tests in three layers. The pure domain logic, with no I/O, gets fast unit tests, and that is most of the code. The part that touches PostgreSQL gets integration tests against a real PostgreSQL, not a mock, because the value of those tests is exactly the semantics of the database: constraints, isolation, how MVCC behaves, how a deadlock is reported. A mock of SQL would test my mock.

For the integration tests I run a real server in a container, one per test package, and I give each test its own schema, created and dropped in the setup, so parallel tests do not collide. The migrations are the same ones that run in production, applied by the same tool, so the suite fails if a migration is broken, and that is the point.

On isolation I prefer a dedicated schema over the rollback pattern, because rollback only works if the code under test does not commit its own transaction and does not open another connection, which is exactly the code I most want to test.

Concurrency is tested explicitly: I run N goroutines trying the same thing, for example inserting with the same idempotency key, and I assert the invariant, that exactly one row exists. The suite always runs with the race detector, and hot paths get a benchmark with a generous budget, so a query that degrades from ten milliseconds to two seconds is caught before production.

**Illustrative example (go)**

```go
func TestConcurrentIdempotentInsert(t *testing.T) {
	t.Parallel()
	db := testdb.New(t) // real Postgres, exclusive schema per test
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := repo.CreateWithIdempotencyKey(ctx, tenantID, "key-1", payload); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("unexpected error: %v", err)
	}

	// invariant: exactly one row, despite the 8 attempts
	var count int
	err := db.QueryRow(ctx, `select count(*) from invoices where tenant_id = $1`, tenantID).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected exactly 1 invoice, got %d", count)
	}
}

// CI: go test -race ./...   (the data race detector on every run)
```

### 15. You are on call at 2 a.m. and API latency jumps from 80 ms to 4 seconds. What do you do in the first 15 minutes?

My priority in the first fifteen minutes is mitigation with evidence, not root cause. I want the impact to stop and I want to explain what I did.

Minutes zero to three, I scope it: all traffic or one route, one tenant, one region? I look at error rate and latency percentiles per route, and whether something changed in the last hour: a deploy, a config change, a dependency, a traffic spike. A deploy that correlates with the onset makes rollback the first candidate, not the last.

Minutes three to seven, I find the bottleneck. Is it the database: slow queries, lock waits, a saturated connection pool? A downstream service timing out, which shows up as latency without errors? Our own process: CPU throttling, garbage collection, a stuck goroutine, a saturated worker pool? I check saturation before anything else, because saturation is what actually kills a service.

Minutes seven to twelve, I mitigate, one change at a time so I know what worked: roll back, scale out, shed load by disabling an expensive feature or serving stale cache, kill a runaway query. Raising timeouts is a last resort, because it moves the pain to the caller.

Minutes twelve to fifteen, I communicate and I write the timeline as I go: what is happening, what I changed, what I am watching.

After stabilisation the work changes: real root cause, the fix, and the alert that would have caught this earlier.

**The first 15 minutes**

- **0–3 min** — Scope: routes, tenants, recent deploy
- **3–7 min** — Bottleneck: database, dependency, process, queue
- **7–12 min** — Mitigate: rollback, scale, shed load, one change at a time
- **12–15 min** — Communicate and write the timeline

Rule of thumb for on call: prefer the reversible change, and change one thing at a time, otherwise you cannot tell what worked.

### 16. What do you monitor in a backend service?

I start from the user-visible signal and work inwards. For a request-driven service I use RED: rate, errors and duration, with duration as percentiles, not averages. Averages hide the tail, and the tail is what users feel; an average of 80 milliseconds with a p99 of four seconds is broken for a few percent of the traffic.

Around that I track saturation, because saturation is the leading indicator of an outage: CPU and throttling, memory and, for a Go service, heap, GC pause and goroutine count. Then the dependency surfaces: connection pool usage and, more importantly, how long a request waits to acquire a connection, query latency, lock waits, queue depth and the age of the oldest item.

Then the three pillars with a clear division of labour: metrics to detect, traces to localise, structured logs for the detail, with request and trace ids so I can jump from a slow span to the exact lines. I also keep one business metric that reflects user impact, because a drop in successful payments matters more than any CPU graph.

On alerting, I alert on symptoms with an SLO and a burn rate, not on causes.

Two disciplines: labels must be bounded, route template and status code, never a user id or a raw URL with an identifier, because unbounded cardinality takes the monitoring bill down; and every alert has a runbook, because an alert without one starts a conversation from zero at 2 a.m.

**Illustrative example (yaml)**

```yaml
# RED: latency percentiles per route (template, never an id)
- record: http.server.request.duration
  expr: histogram_quantile(0.99, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))
  labels: { service: payments, route: /v1/invoices }

# saturation: waiting for a connection (early indicator of an incident)
- record: db.pool.acquire_wait
  expr: histogram_quantile(0.95, sum by (le) (rate(pgx_pool_acquire_wait_seconds_bucket[5m])))

# Go runtime metrics, exported by the process
- record: go.goroutines
  expr: go_goroutines{job="payments"}
- record: go.gc.pause
  expr: go_gc_duration_seconds{job="payments"}

# alerting on a symptom, with a runbook
- alert: PaymentsLatencyBurn
  expr: http_server_request_duration_seconds{job="payments"} > 1.5
  for: 10m
  labels: { severity: page }
  annotations:
    summary: "latency above the SLO"
    runbook_url: "https://runbooks/payments-latency"   # every alert has a runbook
```

## AI in day-to-day work

### 17. Walk me through the last feature you built using an AI coding assistant. What did you delegate and what did you do yourself?

A representative example is the delivery workflow I built and still run for the engineering team: a developer opens a task, an orchestration layer turns it into a job, coding agents work on it, and the result comes back as a pull request that a human reviews before anything is merged.

What I delegated to the agents is the well-bounded implementation work: scaffolding inside a module, the mechanical parts, tests for code that has already been designed, and refactors with a clear specification.

What I kept is the design and the accountability: interface contracts, the data model, the security boundaries and permissions, the decision of what is worth building, and the review of every pull request. I do not merge code I have not read; if I cannot explain a line in the review, it does not get merged, no matter how confident the assistant sounds.

The workflow also carries an evaluation loop: the agent configurations and prompts are versioned, and I use promptfoo, a third-party evaluation tool, to test changes before they are promoted, so a prompt change is an evaluated change rather than a matter of taste. In a separate repository I keep golden datasets and an evaluation harness for the model behaviour itself.

I distinguish agent evaluation from the test oracle for the code it produces. An oracle defines the expected result independently of the proposed implementation: a business invariant, a known input/output pair, or a regression test that reproduces the failure. My acceptance criterion is not simply that an agent's own tests pass. I want checks derived from the specification, including failure and concurrency cases where relevant, plus human review. An illustrative oracle for an idempotent endpoint is that concurrent retries create exactly one business record and return the same resource. promptfoo evaluates agent behaviour; it does not replace these application-level checks.

One failure taught me the most: some jobs finished their work and then hung, and the runner marked them failed, because a watch-mode reload restarted the process in the middle of a job. The fix was structural, isolating each job in its own process, and it became an architecture decision record rather than a patch.

**Delivery workflow (illustrative)**

- **1. Task** — a developer opens the task with the specification
- **2. Orchestration** — the task becomes a job, with state and traces
- **3. Coding agents** — they work in an isolated workspace with tools and context
- **4. Pull request** — the result comes back as a pull request
- **5. Review** — CI plus human review before anything is merged

The design principles I hold to: the agent produces code, a human owns the decision and the merge, and the interfaces, data model and security boundaries are designed, not generated.

### 18. Tell me about a time you rejected or corrected code generated by AI. What was wrong?

A concrete related example was correcting an AI-assisted investigation rather than rejecting a generated code patch.

We were losing conversion on checkout, and I used an AI-assisted workflow to search the logs. The first thing the assistant did was query Kibana, and it queried the wrong environment: staging instead of production. That burned about ten minutes before I noticed the target was wrong. I stopped that session, restarted the investigation against the right environment, and in about twenty minutes the assistant located the actual change: a wrongly renamed variable in the frontend, in the code path associated with the fraud classification. That defect was in existing frontend code; the assistant located it, it did not introduce it.

What was wrong with the output is not a bug in the code, it is a wrong premise: it was confidently answering a question about an environment nobody was asking about. My correction was to validate where the evidence comes from before trusting the conclusion.

The criterion I apply to generated code is the same one: a patch has to be read against the failure scenario, not against how confident it sounds. Concretely, for an idempotent write I would not accept a check-then-insert without a unique constraint, because two concurrent requests can both pass the check and create duplicates; the constraint, inside the same transaction, is what makes it safe.

**Illustrative example (go)**

```go
// check-then-insert without a unique constraint.
// It passes any sequential test and fails in production under concurrency.
exists, _ := store.Exists(ctx, tenantID, key)
if !exists {
    inv, _ := store.Insert(ctx, tenantID, payload) // both requests insert
    return inv, nil
}

// with a unique constraint, in the same transaction:
// insert into idempotency_keys (tenant_id, idempotency_key, request_hash)
// values ($1, $2, $3)
// on conflict (tenant_id, idempotency_key) do nothing;
// rows affected == 0 -> the other request won: re-read and replay its response
```

### 19. Have you built any feature using LLMs, for example with LangChain, LangGraph or a vector database?

Yes, several, and they are separate systems, so let me keep them apart.

The first is my own product, adsmaker, which turns a URL into a video ad: it synthesises the brand, a creative director step produces a scene plan as versioned JSON, and that plan drives text to speech, subtitles and the render. The interesting engineering is multimodal: OCR frame by frame, a vision model reviewing frames, a grid burned into the frames so the model can address a defect by coordinates, and ffmpeg as the image processor. The product is live and still in research and development while I validate use cases.

The second is alethe, a code intelligence RAG. Instead of embedding raw files, it parses real ASTs with Roslyn, the TypeScript compiler and Pyright, builds a semantic graph of the code base, applies a graph convolution to retrieve, and exposes it over REST and MCP. Locally it runs on SQLite with sqlite-vec; in a multi-repo deployment I built the PostgreSQL version with pgvector and Apache AGE. The graph matters because structural relations, who calls whom, are not similarity.

The third is ai-onboard, where I separate an intent engine from a decision engine. The intent engine classifies a support message into a defined intent and extracts structured fields. I evaluate intent classification, extraction and injection guardrails separately rather than treating the whole pipeline as one opaque answer. The model's interpretation is evidence, not permission to execute an action.

For a concrete decision engine, vaga-hunter uses the same separation in a different domain: the LLM extracts structured facts from job descriptions, while a deterministic policy applies eligibility gates and scoring rules. The model does not assign the final score. These are separate projects illustrating a design principle, not a claim that they share one deployed runtime.

The golden datasets in ai-onboard provide reviewed inputs and expected outputs: 363 intent examples across five classes, with a seeded, stratified development/test split of 217/146; separate datasets cover prompt injection and structured extraction. An audit checks overlap between prompt examples and evaluation data to catch leakage. I use development data for iteration and keep test data separate; repeatedly tuning against test results would undermine that separation. Versioned run results include accuracy, per-class precision/recall/F1 and confusion matrices.

For the agents themselves I use promptfoo, a third-party evaluation tool, to test changes in versioned agent configurations and prompts. This is complementary to the separate ai-onboard harness, not a claim that promptfoo runs that repository's datasets. The test oracle is the explicit reference that decides whether an output is acceptable: a reviewed intent label, an expected extracted field, or a deterministic business invariant. For generated code, the oracle must be grounded in the specification rather than merely agreeing with the implementation. A model-generated explanation is not, by itself, proof of correctness.

The common thread is not the framework: the model reads and the code decides.

**Intent, decisions and verification (illustrative design)**

- **1. Intent engine** — classify the request and extract structured fields
- **2. Decision engine** — apply explicit business rules, permissions and escalation criteria
- **3. Golden dataset** — compare predictions with reviewed labels and expected fields
- **4. promptfoo** — evaluate changes to agent prompts and configurations
- **5. Test oracle** — check expected outcomes and invariants independently of the implementation

The golden dataset and oracle define what correct means; the evaluation harness measures it. This diagram connects the concepts, not the deployment topology of the separate projects above.

**Illustrative example (sql)**

```sql
-- multi-repo retrieval with pgvector
create extension if not exists vector;

create table code_chunks (
  id         bigserial primary key,
  repo       text        not null,
  symbol     text        not null,
  kind       text        not null,      -- function | class | interface | method
  embedding  vector(768) not null,
  source     text        not null
);

-- similarity search filtered by repository
select repo, symbol, kind
from code_chunks
where repo = $1
order by embedding <=> $2::vector   -- cosine distance
limit 20;

-- besides the vector, the graph holds the structural relations:
-- who calls whom, implements which interface, inherits from what
```

## Ownership and working with Product

### 20. Tell me about a workstream you owned from design to production without supervision. How did you break it down and prioritize?

The workstream I owned end to end is adsmaker, a product that turns a URL into a video ad. It is my own product: the architecture, the code, the pipeline and the operations are mine, working with third-party libraries and frameworks where those are the right tool. It started while I was helping my wife prepare a campaign for a product, and it is live today, still in research and development while I validate use cases. I am not claiming traction or revenue.

How I break work like this down is a principle rather than a fixed schedule, because the order changed as I learned the problem. I get a complete path working end to end before I optimise any stage: a complete output, even a mediocre one, tells me where the real bottleneck is, while a beautiful fragment tells me nothing about the pipeline. Then I improve one stage at a time, in the order the bottleneck actually shows up, and I keep the scope narrow on purpose, because in a solo project the binding constraint is my own attention, not the market.

Two design decisions have carried most of the weight. The scene plan is versioned JSON, so the creative direction is data: I can regenerate a video without re-running the whole pipeline, and change one stage without touching the others. And the code is modular, in a dozen packages, so each stage evolves independently.

Prioritisation, in one line: what blocks the next stage, then what a user would notice, then what is cheap.

**Pipeline shape (illustrative)**

- **Input** — the campaign URL
- **Brand synthesis** — language and identity extracted
- **Creative direction** — scene plan as versioned JSON
- **Media** — text to speech, subtitles, frame OCR
- **Render** — render plus automated visual review

Two decisions make this pipeline cheap to change: the scene plan is data, and each stage is an independent package, so a video can be regenerated without re-running everything.

### 21. Product asks you for a feature you think is a bad idea or is not well defined. What do you do?

My first move is to separate the request from the problem, because most bad features are a solution that arrived before the problem was written down. So I ask what outcome they want, for whom, how many, and what they do today. With usage data or tickets, the conversation becomes about evidence instead of taste.

Then I reframe. If the request is well-founded but the solution is not the best one, I bring options instead of a refusal: do nothing, a smaller slice that tests the risky assumption, or a different approach. If the requirement is undefined, I propose a time-boxed spike to answer the question that blocks the decision.

When I write the recommendation, I make the trade-offs explicit, so the decision can be made by whoever has the business context: impact, effort, risk and what we give up. I bring a recommendation, not a list of risks, because risks without a proposal just transfer the problem back.

If the risk is legal, security or financial, I escalate and document it. If the decision goes against me, I execute it properly and make the risk visible: monitoring for the outcome we feared, and a kill switch.

The same skill applies to a large migration I decomposed: we agreed on the decomposition and on incremental delivery, shipping slices instead of one big cutover.

What I avoid is the disagreement living only in my head, and even more, being the person who says no to everything.

**A one-page note for the conversation with Product (illustrative)**

| Field | What to write |
| --- | --- |
| Problem | who suffers, how often, evidence (usage, tickets, data) |
| Request versus solution | the expected outcome, separate from the proposed mechanism |
| Options | do nothing / smallest slice / alternative approach, with cost and risk |
| Recommendation | my choice and why, in one sentence |
| Trade-offs | expected impact, effort, risk, what we stop doing |
| Decision | who decides, by when, and what we monitor if the decision goes the other way |

## Delivery & CI/CD

This appendix describes the delivery path of this page and of its Markdown export, and how the CI/CD is split between a public validation pipeline and a private promotion pipeline.

### Public source

The site is one HTML file with no framework, no build step and no runtime dependency: a single data array drives both the page and the Markdown export, and the browser is the only runtime. The source, the export script and the tests are public.

- [Repository](https://github.com/nklaveren/matw-playbook)
- [Workflow runs](https://github.com/nklaveren/matw-playbook/actions/workflows/site.yml)

### What the public pipeline does

The "Validate site" workflow runs on GitHub-hosted runners with read-only repository permissions. It parses the inline JavaScript, checks the question entries and the static Markdown, runs the unit and browser tests, and — only for a successful push to main — uploads an artifact named "site" that contains exactly two files: index.html and senior-fullstack-engineering-answers.md.

There the public pipeline stops: it never deploys and never authenticates against a production environment.

### What the private pipeline does

Deployment lives in a separate private repository. Its pipeline consumes a successful run of the public workflow from main and updates the private GitOps manifests. Promotion to production is a manual trigger inside the private repository, not an automatic push from the public one.

### Where the boundary is

Cluster manifests stay in the private repository; cluster credentials and network access stay with the deployment controller. The public workflow has neither and never clones a private repository.

Only the artifact crosses the boundary: two static files, validated by the public pipeline and promoted by a human in the private one.
